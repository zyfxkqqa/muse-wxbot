// Host-side privileged functions for the WeChat bot viewer.
//
// The portable action bundle must not import Node/Bun host modules, so all
// filesystem access to the WeChat bot's own state lives here:
//   - bindings:  ~/workspace/skills/wechat-bot/state/bindings.json
//     (the live skill dir — the hook script's SKILL_DIR points there; the
//     copy under ~/workspace/custom-skills is stale and is NOT read)
//   - histories: ~/hooks/state/wechat-convs/<sha>/ where
//     sha = first 16 hex chars of sha256("<botId>:<ownerExternalId>"),
//     containing meta.json + current.jsonl + archive/<conversationId>.jsonl
//
// SECURITY: bindings.json contains the bot token and the poll cursor
// (metadata.getUpdatesBuf). Those fields are never copied into any response —
// the handlers below build fresh objects with only display-safe fields.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

const conversationSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  status: z.string(),
  messageCount: z.number(),
});

const mediaItemSchema = z.object({
  kind: z.string(),
  localPath: z.string(),
});

const messageSchema = z.object({
  ts: z.string(),
  role: z.string(),
  text: z.string(),
  // Optional media attachments, recorded by the hook when a message
  // carries media with a localPath: [{kind, localPath}]. The viewer renders
  // them (image/video/voice/file) next to the message text.
  media: z.array(mediaItemSchema).optional(),
});

export const WechatPrivileged = definePrivilegedContracts({
  listBotsAndConversations: {
    request: z.object({}),
    response: z.object({
      bots: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          displayName: z.string(),
          platformBotId: z.string(),
          ownerExternalId: z.string(),
          createdAt: z.string(),
          lastError: z.string().nullable(),
          conversations: z.array(
            z.object({
              id: z.string(),
              label: z.string(),
              createdAt: z.string(),
              status: z.string(),
              messageCount: z.number(),
            }),
          ),
        }),
      ),
      bindingsFound: z.boolean(),
    }),
  },
  getConversationMessages: {
    request: z.object({
      botId: z.string(),
      conversationId: z.string(),
    }),
    response: z.object({
      found: z.boolean(),
      messages: z.array(
        z.object({
          ts: z.string(),
          role: z.string(),
          text: z.string(),
          media: z.array(mediaItemSchema).optional(),
        }),
      ),
    }),
  },
  // Serves one media file (image/video/voice/file) from the bot's media
  // folder so the viewer can display it. Only files under
  // ~/workspace/wechat-media/ are ever served; anything else is refused.
  getMediaFile: {
    request: z.object({
      localPath: z.string(),
    }),
    response: z.object({
      found: z.boolean(),
      mime: z.string(),
      base64: z.string(),
      size: z.number(),
    }),
  },
});

const BINDINGS_PATH = join(
  homedir(),
  "workspace",
  "skills",
  "wechat-bot",
  "state",
  "bindings.json",
);
const CONVS_ROOT = join(homedir(), "hooks", "state", "wechat-convs");

// Media attachments downloaded by the hook live here. getMediaFile only
// ever serves files under this root (see the path check there).
const MEDIA_ROOT = join(homedir(), "workspace", "wechat-media");
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

function mimeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".silk":
      return "audio/silk";
    default:
      return "application/octet-stream";
  }
}

interface Binding {
  id: string;
  label: string;
  displayName: string;
  platformBotId: string;
  ownerExternalId: string;
  createdAt: string;
  lastError: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function readBindings(): Promise<Binding[] | null> {
  let raw: string;
  try {
    raw = await readFile(BINDINGS_PATH, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const bindings: Binding[] = [];
  for (const item of parsed) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = asString(rec.id);
    const ownerExternalId = asString(rec.ownerExternalId);
    if (!id || !ownerExternalId) continue;
    const metadata = asRecord(rec.metadata) ?? {};
    const lastErrorRaw = metadata.lastError;
    bindings.push({
      id,
      label: asString(metadata.label) || asString(rec.displayName) || id.slice(0, 8),
      displayName: asString(rec.displayName),
      platformBotId: asString(rec.platformBotId),
      ownerExternalId,
      createdAt: asString(rec.createdAt),
      lastError: typeof lastErrorRaw === "string" && lastErrorRaw ? lastErrorRaw : null,
    });
  }
  return bindings;
}

function convFolder(binding: Binding): string {
  const sha = createHash("sha256")
    .update(`${binding.id}:${binding.ownerExternalId}`)
    .digest("hex")
    .slice(0, 16);
  return join(CONVS_ROOT, sha);
}

interface ConversationMeta {
  id: string;
  label: string;
  createdAt: string;
  status: string;
}

async function readMeta(
  folder: string,
): Promise<{ conversations: ConversationMeta[]; currentId: string } | null> {
  let raw: string;
  try {
    raw = await readFile(join(folder, "meta.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec = asRecord(parsed);
  if (!rec || !Array.isArray(rec.conversations)) return null;
  const conversations: ConversationMeta[] = [];
  for (const item of rec.conversations) {
    const c = asRecord(item);
    if (!c) continue;
    const id = asString(c.id);
    if (!id) continue;
    conversations.push({
      id,
      label: asString(c.label) || id,
      createdAt: asString(c.created_at),
      status: asString(c.status) || "archived",
    });
  }
  return { conversations, currentId: asString(rec.current_id) };
}

// Counts messages exactly the way getConversationMessages parses them:
// a line counts only when it is valid JSON whose role is user/assistant.
// (Counting raw non-empty lines instead would drift from the transcript
// whenever a half-written or foreign line lands in the file, and the
// unread count built on top of it could never reach zero.)
function countMessages(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;
    const role = asString(rec.role);
    if (role === "user" || role === "assistant") n++;
  }
  return n;
}

async function readJsonl(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function conversationFile(folder: string, meta: ConversationMeta): string {
  return meta.status === "current"
    ? join(folder, "current.jsonl")
    : join(folder, "archive", `${meta.id}.jsonl`);
}

export const WechatPrivilegedHandlers = definePrivilegedHandlers(
  WechatPrivileged,
  {
    async listBotsAndConversations() {
      const bindings = await readBindings();
      if (bindings === null) {
        return { bots: [], bindingsFound: false };
      }
      const bots = [];
      for (const binding of bindings) {
        const folder = convFolder(binding);
        const meta = await readMeta(folder);
        const conversations: z.infer<typeof conversationSchema>[] = [];
        if (meta) {
          // meta.json stores oldest → newest; the viewer lists newest first.
          for (const c of [...meta.conversations].reverse()) {
            const content = await readJsonl(conversationFile(folder, c));
            conversations.push({
              id: c.id,
              label: c.label,
              createdAt: c.createdAt,
              status: c.status,
              messageCount: content === null ? 0 : countMessages(content),
            });
          }
        }
        bots.push({
          id: binding.id,
          label: binding.label,
          displayName: binding.displayName,
          platformBotId: binding.platformBotId,
          ownerExternalId: binding.ownerExternalId,
          createdAt: binding.createdAt,
          lastError: binding.lastError,
          conversations,
        });
      }
      return { bots, bindingsFound: true };
    },

    async getConversationMessages(args) {
      const bindings = (await readBindings()) ?? [];
      const binding = bindings.find((b) => b.id === args.botId);
      if (!binding) return { found: false, messages: [] };
      const folder = convFolder(binding);
      const meta = await readMeta(folder);
      if (!meta) return { found: false, messages: [] };
      // Only ids present in meta.json are ever turned into file paths, so a
      // crafted conversationId cannot escape the conversation folder.
      const conversation = meta.conversations.find(
        (c) => c.id === args.conversationId,
      );
      if (!conversation) return { found: false, messages: [] };
      const content = await readJsonl(conversationFile(folder, conversation));
      if (content === null) return { found: true, messages: [] };
      const messages: z.infer<typeof messageSchema>[] = [];
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue; // a half-written line never breaks the whole transcript
        }
        const rec = asRecord(parsed);
        if (!rec) continue;
        const role = asString(rec.role);
        if (role !== "user" && role !== "assistant") continue;
        // Optional media attachments: [{kind, localPath}]. Only keep items
        // that actually name a kind and a path; anything malformed is
        // dropped rather than breaking the whole transcript.
        let media: Array<{ kind: string; localPath: string }> | undefined;
        if (Array.isArray(rec.media)) {
          const items: Array<{ kind: string; localPath: string }> = [];
          for (const item of rec.media) {
            const m = asRecord(item);
            if (!m) continue;
            const kind = asString(m.kind);
            const localPath = asString(m.localPath);
            if (!kind || !localPath) continue;
            items.push({ kind, localPath });
          }
          if (items.length > 0) media = items;
        }
        messages.push({
          ts: asString(rec.ts),
          role,
          text: asString(rec.text),
          ...(media ? { media } : {}),
        });
      }
      return { found: true, messages };
    },

    async getMediaFile(args) {
      // Resolve the path and require it to stay under the media root, so a
      // crafted localPath can never read an arbitrary file on the host.
      const resolved = resolve(args.localPath);
      if (resolved !== MEDIA_ROOT && !resolved.startsWith(MEDIA_ROOT + sep)) {
        return { found: false, mime: "", base64: "", size: 0 };
      }
      // Voice arrives as .silk, which no browser can play; when a
      // same-name .mp3 transcode sits next to it, serve that instead.
      let target = resolved;
      if (resolved.toLowerCase().endsWith(".silk")) {
        const mp3 = `${resolved.slice(0, resolved.length - ".silk".length)}.mp3`;
        const mp3Stat = await stat(mp3).catch(() => null);
        if (mp3Stat?.isFile()) target = mp3;
      }
      // Stat first: an oversized file is refused before a single byte of
      // it is read into memory.
      const st = await stat(target).catch(() => null);
      if (!st?.isFile()) {
        return { found: false, mime: "", base64: "", size: 0 };
      }
      if (st.size > MAX_MEDIA_BYTES) {
        return { found: false, mime: "", base64: "", size: st.size };
      }
      let buf: Buffer;
      try {
        buf = await readFile(target);
      } catch {
        return { found: false, mime: "", base64: "", size: 0 };
      }
      return {
        found: true,
        mime: mimeForPath(target),
        base64: buf.toString("base64"),
        size: buf.length,
      };
    },
  },
);
