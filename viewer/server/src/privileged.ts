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
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

const messageSchema = z.object({
  ts: z.string(),
  role: z.string(),
  text: z.string(),
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
        }),
      ),
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

function countLines(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.trim()) n++;
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
              messageCount: content === null ? 0 : countLines(content),
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
        messages.push({
          ts: asString(rec.ts),
          role,
          text: asString(rec.text),
        });
      }
      return { found: true, messages };
    },
  },
);
