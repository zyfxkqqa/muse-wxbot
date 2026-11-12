// Host-side privileged functions for the WeChat bot viewer.
//
// The portable action bundle must not import Node/Bun host modules, so all
// filesystem access to the WeChat bot's own state lives here:
//   - bindings:  ~/workspace/skills/wechat-bot/state/bindings.json
//     (the live skill dir — the hook script's SKILL_DIR points there; the
//     copy under ~/workspace/custom-skills is stale and is NOT read)
//   - histories: ~/workspace/wechat-bots/<botId first 8 chars>/convs/<sha>/
//     where sha = first 16 hex chars of sha256("<botId>:<ownerExternalId>"),
//     containing meta.json + current.jsonl + archive/<conversationId>.jsonl
//     (plan-B isolated location only; the legacy ~/hooks/state/wechat-convs/
//     tree is not read)
//
// SECURITY: bindings.json contains the bot token and the poll cursor
// (metadata.getUpdatesBuf). Those fields are never copied into any response —
// the handlers below build fresh objects with only display-safe fields.

import { createHash, randomBytes } from "node:crypto";
import { access, appendFile, chmod, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
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
          conversationSha: z.string(),
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
          // NOTE: inlined rather than z.array(mediaItemSchema) — the build
          // extracts this contract literal into a generated file that does
          // not carry local consts, so a reference here fails typecheck.
          // The shape is identical to mediaItemSchema.
          media: z
            .array(z.object({ kind: z.string(), localPath: z.string() }))
            .optional(),
        }),
      ),
    }),
  },
  getMediaFile: {
    request: z.object({
      localPath: z.string(),
    }),
    response: z.object({
      found: z.boolean(),
      dataBase64: z.string(),
      mimeType: z.string(),
      size: z.number(),
      filename: z.string(),
    }),
  },
  sendMessage: {
    request: z.object({
      botId8: z.string(),
      conversationSha: z.string(),
      text: z.string(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
  },
  sendMedia: {
    request: z.object({
      botId8: z.string(),
      conversationSha: z.string(),
      filename: z.string(),
      dataBase64: z.string(),
      mimeType: z.string(),
      caption: z.string(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      compressed: z.boolean(),
      originalBytes: z.number(),
      finalBytes: z.number(),
    }),
  },
  setPaused: {
    request: z.object({
      botId8: z.string(),
      conversationSha: z.string(),
      paused: z.boolean(),
    }),
    response: z.object({
      paused: z.boolean(),
      error: z.string().nullable(),
    }),
  },
  getPaused: {
    request: z.object({
      botId8: z.string(),
      conversationSha: z.string(),
    }),
    response: z.object({
      paused: z.boolean(),
      error: z.string().nullable(),
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
// Per-bot isolated roots (plan B): ~/workspace/wechat-bots/<botId8>/
// The viewer reads ONLY the new isolated locations:
//   conversations: <botRoot>/convs/<sha>/
//   media:         <botRoot>/media/
// Legacy locations (~/hooks/state/wechat-convs/ and ~/workspace/wechat-media/)
// are intentionally NOT read — old conversations/media appear only after the
// bot worker's compatibility copy moves them into the per-bot root.
const BOTS_ROOT = join(homedir(), "workspace", "wechat-bots");
const BOTS_ROOT_RESOLVED = resolve(BOTS_ROOT);
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const MEDIA_KINDS = new Set(["image", "voice", "video", "file"]);

// Sending (viewer send box): the bot CLI that owns the iLink send call.
const CLI_PATH = join(
  homedir(),
  "workspace",
  "skills",
  "wechat-bot",
  "dist",
  "cli.js",
);
const SENT_LOG_PATH = join(
  homedir(),
  "workspace",
  "skills",
  "wechat-bot",
  "state",
  "sent-log.jsonl",
);
// Pause flags live beside the other hook markers (wechat-intro-pending.*).
const HOOKS_STATE_DIR = join(homedir(), "hooks", "state");
const MAX_SEND_CHARS = 2000;
const CLI_SEND_TIMEOUT_MS = 20_000;
const DIRECT_SEND_TIMEOUT_MS = 15_000;
// Media send (viewer attach): a 5 MiB video is the platform's upload
// ceiling (4.6MB uploaded fine, 5.5MB failed with HTTP 500 on the CDN).
// Other kinds get a 20 MiB safety cap so an action payload stays sane.
const CLI_SEND_MEDIA_TIMEOUT_MS = 60_000;
const VIDEO_MAX_BYTES = 5 * 1024 * 1024;
const MEDIA_SEND_MAX_BYTES = 20 * 1024 * 1024;
// Images above this size reliably fail the platform CDN upload (529 KB
// failed five times; 246 KB went through). Larger images are compressed
// in place with PIL before the CLI send — see compressImageFile below.
const IMAGE_COMPRESS_THRESHOLD_BYTES = 256000;
const COMPRESS_TIMEOUT_MS = 30_000;
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "webm"]);
const AUDIO_EXTS = new Set(["mp3", "m4a", "wav", "ogg", "aac", "flac", "amr"]);

type MediaSendKind = "image" | "video" | "voice" | "file";

/** Kind from the filename extension — the same inference the CLI applies
 *  (image/video by extension, .silk as voice, anything else as file).
 *  Audio that is not .silk is rejected by the handler before this runs. */
function inferMediaKind(ext: string): MediaSendKind {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (ext === "silk") return "voice";
  return "file";
}

const MEDIA_PLACEHOLDER: Record<MediaSendKind, string> = {
  image: "[图片]",
  video: "[视频]",
  voice: "[语音]",
  file: "[文件]",
};

/** Beijing calendar date (YYYY-MM-DD) for the per-day media folder. */
function beijingDateString(): string {
  return new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  silk: "audio/silk",
  pdf: "application/pdf",
  txt: "text/plain",
};

function mimeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Parse a history line's `media` field: only well-formed entries with a
 *  known kind and a non-empty path survive; anything else is dropped. */
function parseMedia(
  value: unknown,
): Array<{ kind: string; localPath: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ kind: string; localPath: string }> = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const kind = asString(rec.kind);
    const localPath = asString(rec.localPath);
    if (!MEDIA_KINDS.has(kind) || !localPath) continue;
    out.push({ kind, localPath });
  }
  return out.length > 0 ? out : undefined;
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

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Normalize a stored timestamp to a Beijing (UTC+8) ISO string with an
 * explicit +08:00 offset. History files mix offsets — most lines carry
 * +08:00, some carry +00:00 (e.g. the 17:13 video message is stored as
 * 09:13:40+00:00) — so parse with the value's own offset first, then shift
 * to Beijing. A timestamp with no offset is read as Beijing time already.
 * Unparseable values pass through untouched (the client renders "" then).
 */
function toBeijingIso(ts: string): string {
  const raw = ts.trim();
  if (!raw) return ts;
  const hasTime = /[T ]\d{2}:\d{2}/.test(raw);
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})\s*$/i.test(raw);
  const candidate =
    hasTime && !hasOffset ? `${raw.replace(" ", "T")}+08:00` : raw;
  const d = new Date(candidate);
  if (Number.isNaN(d.getTime())) return ts;
  // Shift the instant by +8h and read it back with UTC getters: those are
  // exactly the Beijing wall-clock fields. toISOString gives
  // "YYYY-MM-DDTHH:mm:ss.sssZ"; swap the Z for the +08:00 offset.
  return new Date(d.getTime() + BEIJING_OFFSET_MS)
    .toISOString()
    .replace("Z", "+08:00");
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
      createdAt: toBeijingIso(asString(rec.createdAt)),
      lastError: typeof lastErrorRaw === "string" && lastErrorRaw ? lastErrorRaw : null,
    });
  }
  return bindings;
}

function convFolder(binding: Binding): string {
  // Plan B only: ~/workspace/wechat-bots/<botId8>/convs/<sha>/
  // No fallback to the legacy shared location. If the folder does not
  // exist yet, readMeta/readJsonl treat it as "no conversations" without
  // erroring — old conversations appear once the worker copies them here.
  return join(BOTS_ROOT, binding.id.slice(0, 8), "convs", contactSha(binding));
}

/** The contact folder sha: first 16 hex of sha256("<botId>:<ownerExternalId>"). */
function contactSha(binding: Binding): string {
  return createHash("sha256")
    .update(`${binding.id}:${binding.ownerExternalId}`)
    .digest("hex")
    .slice(0, 16);
}

/** Current Beijing wall-clock time as ISO with an explicit +08:00 offset
 *  and no milliseconds — the exact shape history lines already use. */
function beijingNowIso(): string {
  return new Date(Date.now() + BEIJING_OFFSET_MS)
    .toISOString()
    .replace(/\.\d{3}Z$/, "+08:00");
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
      createdAt: toBeijingIso(asString(c.created_at)),
      status: asString(c.status) || "archived",
    });
  }
  return { conversations, currentId: asString(rec.current_id) };
}

/**
 * Counts messages exactly the way getConversationMessages parses them: a
 * line counts only when it is valid JSON whose role is user/assistant.
 * (Counting raw non-empty lines instead would drift from the transcript
 * whenever a half-written or foreign line lands in the file, and the unread
 * count built on top of it could never reach zero.)
 */
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

/* ---------- viewer send box + pause toggle ---------- */

// Full credential record for one binding, read server-side only. The token
// and baseUrl never leave this file: no handler returns them, and no log
// line ever includes them.
interface BindingSecret {
  id: string;
  token: string;
  baseUrl: string;
  ownerExternalId: string;
}

async function readBindingSecret(id: string): Promise<BindingSecret | null> {
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
  for (const item of parsed) {
    const rec = asRecord(item);
    if (!rec || asString(rec.id) !== id) continue;
    const token = asString(rec.token);
    const baseUrl = asString(rec.baseUrl);
    const ownerExternalId = asString(rec.ownerExternalId);
    if (!token || !baseUrl || !ownerExternalId) return null;
    return { id, token, baseUrl, ownerExternalId };
  }
  return null;
}

type ResolvedConversation =
  | { error: string }
  | { binding: Binding; sha: string; folder: string };

/**
 * Resolve the (botId8, conversationSha) pair the client sends into a real
 * bot and conversation folder. A conversation belongs to exactly one bot:
 * its sha is derived from that bot's id and owner, so a sha that does not
 * match the bot's own folder can never resolve. Nothing here is trusted
 * from the client — the binding and the owner come from bindings.json.
 */
async function resolveBotConversation(
  botId8: string,
  conversationSha: string,
): Promise<ResolvedConversation> {
  if (!/^[0-9a-f]{8}$/i.test(botId8)) {
    return { error: "机器人不存在" };
  }
  if (!/^[0-9a-f]{16}$/i.test(conversationSha)) {
    return { error: "对话不存在" };
  }
  const bindings = await readBindings();
  if (bindings === null) {
    return { error: "绑定记录读取失败" };
  }
  const matches = bindings.filter((b) =>
    b.id.toLowerCase().startsWith(botId8.toLowerCase()),
  );
  if (matches.length !== 1) {
    return { error: "机器人不存在" };
  }
  const binding = matches[0];
  if (!binding) {
    return { error: "机器人不存在" };
  }
  const sha = contactSha(binding);
  if (sha !== conversationSha.toLowerCase()) {
    return { error: "对话不属于这台机器人" };
  }
  return { binding, sha, folder: convFolder(binding) };
}

/** The pause flag for one conversation: an empty file, existence = paused. */
function pausedFlagPath(botId8: string, sha: string): string {
  return join(HOOKS_STATE_DIR, `wechat-paused.${botId8.toLowerCase()}.${sha.toLowerCase()}`);
}

async function pausedExists(botId8: string, sha: string): Promise<boolean> {
  try {
    await access(pausedFlagPath(botId8, sha));
    return true;
  } catch {
    return false;
  }
}

/** The CLI prints {"type":"error","message":"..."} and exits 1 on failure. */
function parseCliError(output: string): string | null {
  const lines = output.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const rec = asRecord(parsed);
      if (rec && rec.type === "error" && typeof rec.message === "string") {
        return rec.message;
      }
    } catch {
      // not a JSON line — keep scanning
    }
  }
  return null;
}

type CliSendResult =
  | { ok: true }
  | { ok: false; ran: boolean; error: string };

/**
 * Preferred send path: the bot CLI, which already owns the iLink call,
 * retries, and sent-log. `ran` is false only when the CLI could not be
 * executed at all (spawn refused / helper missing) — the caller may then
 * fall back to a direct API call. When the CLI ran and the platform
 * refused, there is no second attempt: the message may already have gone
 * out, so retrying could double-send.
 */
async function runCliSend(
  botId: string,
  to: string,
  text: string,
): Promise<CliSendResult> {
  try {
    await access(CLI_PATH);
  } catch {
    return { ok: false, ran: false, error: "发送工具缺失" };
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      ["node", CLI_PATH, "send", "--bot", botId, "--to", to, "--text", text],
      { stdout: "pipe", stderr: "pipe", env: process.env },
    );
  } catch (e) {
    return {
      ok: false,
      ran: false,
      error: `发送工具启动失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, CLI_SEND_TIMEOUT_MS);
  let out = "";
  let err = "";
  let code: number | null = null;
  try {
    [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (e) {
    return {
      ok: false,
      ran: true,
      error: `发送失败：${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
  if (code === 0) return { ok: true };
  const message =
    parseCliError(out) ?? parseCliError(err) ?? `发送失败（exit ${String(code)}）`;
  return { ok: false, ran: true, error: message };
}

/**
 * Media send via the bot CLI (send-media), mirroring runCliSend. The CLI
 * owns the CDN upload, the send, and the sent-log entry (with kind/file).
 * `ran` is false only when the CLI could not be executed at all — there is
 * no direct-API fallback for media (the upload needs a CDN presigned URL
 * plus AES encryption), so the caller reports the failure.
 */
async function runCliSendMedia(
  botId: string,
  to: string,
  file: string,
  kind: MediaSendKind,
  caption: string,
): Promise<CliSendResult> {
  try {
    await access(CLI_PATH);
  } catch {
    return { ok: false, ran: false, error: "发送工具缺失" };
  }
  let proc: ReturnType<typeof Bun.spawn>;
  const argv = [
    "node",
    CLI_PATH,
    "send-media",
    "--bot",
    botId,
    "--to",
    to,
    "--file",
    file,
    "--kind",
    kind,
  ];
  if (caption) argv.push("--text", caption);
  try {
    proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
  } catch (e) {
    return {
      ok: false,
      ran: false,
      error: `发送工具启动失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, CLI_SEND_MEDIA_TIMEOUT_MS);
  let out = "";
  let err = "";
  let code: number | null = null;
  try {
    [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (e) {
    return {
      ok: false,
      ran: true,
      error: `发送失败：${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
  if (code === 0) return { ok: true };
  const message =
    parseCliError(out) ?? parseCliError(err) ?? `发送失败（exit ${String(code)}）`;
  return { ok: false, ran: true, error: message };
}

/**
 * Fallback send path, used only when the CLI subprocess cannot be executed
 * at all. Replicates the CLI's sendText call byte-for-byte: the same
 * endpoint, headers, and message body. The response check mirrors
 * api.sendText exactly (P1-12, 2026-11-12): an HTTP 2xx alone is NOT a
 * success — ret/errcode must be parsed and a non-zero value fails the send,
 * otherwise an HTTP 200 with ret!=0 would be falsely logged as "sent"
 * (the C-5 defect). Only a parsed, ret/errcode-clean response counts, and
 * its message_id is returned for the sent-log. sent:true means the platform
 * accepted the request, never confirmed delivery.
 */
async function directSendText(
  secret: BindingSecret,
  to: string,
  text: string,
): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  const clientId = `wechat-bot-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const uin = Buffer.from(
    String(randomBytes(4).readUInt32BE(0)),
    "utf8",
  ).toString("base64");
  const base = secret.baseUrl.endsWith("/")
    ? secret.baseUrl
    : `${secret.baseUrl}/`;
  const url = new URL("ilink/bot/sendmessage", base).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": uin,
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 4),
        Authorization: `Bearer ${secret.token}`,
      },
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: "",
        },
        base_info: {
          channel_version: "2.4.4",
          bot_agent: "ReusableWechatBot/0.1.0 OpenClaw/2.4.4",
        },
      }),
      signal: AbortSignal.timeout(DIRECT_SEND_TIMEOUT_MS),
    });
  } catch (e) {
    return {
      ok: false,
      error: `发送失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, error: `发送失败（HTTP ${res.status}）：${raw.slice(0, 200)}` };
  }
  // P1-12: same ret+errcode check as api.sendText
  // (src/wechat-clawbot-api.ts sendText). An HTTP 200 with ret!=0 is a
  // failed send, not a success, and must never be logged as "sent". The
  // check only fires when the field is present and non-zero — a response
  // without ret/errcode still succeeds. A body that cannot be parsed at
  // all cannot confirm a send, so it fails closed (api.sendText throws
  // on the same unparsable body).
  let parsed: { ret?: number; errcode?: number; errmsg?: string; message_id?: string };
  try {
    parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string; message_id?: string };
  } catch {
    return { ok: false, error: `发送失败：平台返回无法解析：${raw.slice(0, 200)}` };
  }
  if (parsed.ret !== undefined && parsed.ret !== 0) {
    return { ok: false, error: `微信 ClawBot 发送消息失败（ret=${parsed.ret}）：${parsed.errmsg ?? ""}` };
  }
  if (parsed.errcode !== undefined && parsed.errcode !== 0) {
    return { ok: false, error: `微信 ClawBot 发送消息失败（errcode=${parsed.errcode}）：${parsed.errmsg ?? ""}` };
  }
  return {
    ok: true,
    ...(typeof parsed.message_id === "string" && parsed.message_id
      ? { messageId: parsed.message_id }
      : {}),
  };
}

/** Mirror of the CLI's sent-log entry, for the direct-API fallback only. */
async function appendSentLog(
  botId: string,
  to: string,
  text: string,
  messageId?: string,
): Promise<void> {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    botId,
    to,
    text,
    actor: "viewer",
    ...(messageId ? { messageId } : {}),
  });
  await appendFile(SENT_LOG_PATH, entry + "\n", "utf8").catch(() => undefined);
  await chmod(SENT_LOG_PATH, 0o600).catch(() => undefined);
}

/**
 * Record a message this viewer sent into the conversation's current
 * history, in the exact assistant-line shape the worker writes —
 * {"ts":"...","role":"assistant","text":"..."}, no seq — so it shows up in
 * the viewer and in the context the reply worker reads.
 */
async function appendAssistantLine(folder: string, text: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  const line = JSON.stringify({
    ts: beijingNowIso(),
    role: "assistant",
    text,
  });
  await appendFile(join(folder, "current.jsonl"), line + "\n", "utf8");
}

/**
 * Record a bot-sent media message: the same assistant-line shape, with a
 * "[图片]"/"[视频]"/"[语音]"/"[文件]" placeholder text and a media field
 * (kind + localPath) so the viewer renders the attachment.
 */
async function appendAssistantMediaLine(
  folder: string,
  kind: MediaSendKind,
  localPath: string,
): Promise<void> {
  await mkdir(folder, { recursive: true });
  const line = JSON.stringify({
    ts: beijingNowIso(),
    role: "assistant",
    text: MEDIA_PLACEHOLDER[kind],
    media: [{ kind, localPath }],
  });
  await appendFile(join(folder, "current.jsonl"), line + "\n", "utf8");
}

/* ---------- large-image auto-compression (viewer send path only) ---------- */

// PIL script: argv[1] = image path, argv[2] = target byte size. Prints one
// JSON line: {"ok":true,"path":...,"size":...} or {"ok":false,"error":...}.
// JPEG-style path (no transparency): re-encode as JPEG, quality 70 first
// (that alone took the known 529 KB cover to 246 KB at full size), then
// lower qualities, then shrink the long edge (1600, 1280, 1024, 800, 640,
// 512, 384, 256, 192, 128).
// Transparent images stay PNG (JPEG would drop the alpha channel) and are
// shrunk by long edge instead (down to 128). Steps are bounded; if even the
// smallest attempt still exceeds the target, the script reports failure —
// an over-limit "success" must never be sent (the CDN rejects it anyway).
const COMPRESS_PY = `
import sys, os, json
inp = sys.argv[1]
target = int(sys.argv[2])
try:
    from PIL import Image
    im = Image.open(inp)
    im.load()
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(0)

def resized(img, max_dim):
    if max_dim is None:
        return img.copy()
    w, h = img.size
    long_edge = max(w, h)
    if long_edge <= max_dim:
        return img.copy()
    scale = max_dim / float(long_edge)
    return img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)

base = inp.rsplit(".", 1)[0] if "." in inp else inp
has_alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
try:
    if has_alpha:
        out = base + ".png"
        best_size = None
        best_path = None
        for dim in [None, 1600, 1280, 1024, 800, 640, 512, 384, 256, 192, 128]:
            cand = resized(im, dim)
            if cand.mode not in ("RGBA", "LA"):
                cand = cand.convert("RGBA")
            tmp = out + ".tmp.png"
            cand.save(tmp, "PNG", optimize=True)
            size = os.path.getsize(tmp)
            if size <= target:
                os.replace(tmp, out)
                if os.path.abspath(out) != os.path.abspath(inp) and os.path.exists(inp):
                    os.remove(inp)
                print(json.dumps({"ok": True, "path": out, "size": size}))
                sys.exit(0)
            keep = out + ".best.png"
            os.replace(tmp, keep)
            if best_size is None or size < best_size:
                if best_path and best_path != keep and os.path.exists(best_path):
                    os.remove(best_path)
                best_size, best_path = size, keep
            elif os.path.exists(keep) and keep != best_path:
                os.remove(keep)
        if best_path is None:
            print(json.dumps({"ok": False, "error": "no compressed candidate produced"}))
            sys.exit(0)
        if best_size > target:
            # Steps exhausted and still over the limit: report failure
            # instead of handing back an unsendable file as a "success".
            if os.path.exists(best_path):
                os.remove(best_path)
            print(json.dumps({"ok": False, "error": "compressed to %d bytes, still over the %d-byte limit" % (best_size, target), "size": best_size}))
            sys.exit(0)
        os.replace(best_path, out)
        if os.path.abspath(out) != os.path.abspath(inp) and os.path.exists(inp):
            os.remove(inp)
        print(json.dumps({"ok": True, "path": out, "size": best_size}))
        sys.exit(0)
    else:
        out = base + ".jpg"
        steps = [(None, 70), (None, 60), (None, 50), (None, 40),
                 (1600, 70), (1600, 60), (1600, 50),
                 (1280, 70), (1280, 60), (1280, 50), (1280, 40),
                 (1024, 70), (1024, 60), (1024, 50),
                 (800, 60), (800, 50), (640, 50),
                 (512, 50), (384, 50), (256, 50), (192, 50), (128, 50)]
        best_size = None
        best_path = None
        for dim, quality in steps:
            cand = resized(im, dim)
            if cand.mode != "RGB":
                cand = cand.convert("RGB")
            tmp = out + ".tmp.jpg"
            cand.save(tmp, "JPEG", quality=quality, optimize=True)
            size = os.path.getsize(tmp)
            if size <= target:
                os.replace(tmp, out)
                if os.path.abspath(out) != os.path.abspath(inp) and os.path.exists(inp):
                    os.remove(inp)
                print(json.dumps({"ok": True, "path": out, "size": size}))
                sys.exit(0)
            keep = out + ".best.jpg"
            os.replace(tmp, keep)
            if best_size is None or size < best_size:
                if best_path and best_path != keep and os.path.exists(best_path):
                    os.remove(best_path)
                best_size, best_path = size, keep
            elif os.path.exists(keep) and keep != best_path:
                os.remove(keep)
        if best_path is None:
            print(json.dumps({"ok": False, "error": "no compressed candidate produced"}))
            sys.exit(0)
        if best_size > target:
            # Steps exhausted and still over the limit: report failure
            # instead of handing back an unsendable file as a "success".
            if os.path.exists(best_path):
                os.remove(best_path)
            print(json.dumps({"ok": False, "error": "compressed to %d bytes, still over the %d-byte limit" % (best_size, target), "size": best_size}))
            sys.exit(0)
        os.replace(best_path, out)
        if os.path.abspath(out) != os.path.abspath(inp) and os.path.exists(inp):
            os.remove(inp)
        print(json.dumps({"ok": True, "path": out, "size": best_size}))
        sys.exit(0)
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(0)
`;

type CompressResult =
  | { ok: true; path: string; size: number }
  | { ok: false; error: string };

async function compressImageFile(path: string): Promise<CompressResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      ["python3", "-c", COMPRESS_PY, path, String(IMAGE_COMPRESS_THRESHOLD_BYTES)],
      { stdout: "pipe", stderr: "pipe", env: process.env },
    );
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, COMPRESS_TIMEOUT_MS);
  let out = "";
  let err = "";
  try {
    [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
  const lines = out.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const rec = asRecord(parsed);
      if (!rec) continue;
      if (rec.ok === true && typeof rec.path === "string" && typeof rec.size === "number") {
        return { ok: true, path: rec.path, size: rec.size };
      }
      if (rec.ok === false) {
        return {
          ok: false,
          error: typeof rec.error === "string" ? rec.error : "压缩失败",
        };
      }
    } catch {
      // not the JSON line — keep scanning
    }
  }
  return {
    ok: false,
    error: err.trim().slice(0, 200) || "压缩没有返回结果",
  };
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
          conversationSha: contactSha(binding),
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
        const media = parseMedia(rec.media);
        messages.push({
          ts: toBeijingIso(asString(rec.ts)),
          role,
          text: asString(rec.text),
          ...(media ? { media } : {}),
        });
      }
      return { found: true, messages };
    },

    async getMediaFile(args) {
      const empty = {
        found: false,
        dataBase64: "",
        mimeType: "",
        size: 0,
        filename: "",
      };
      // Resolve first so `..` segments and relative tricks collapse before
      // the containment check: the file must sit strictly under a per-bot
      // media folder — ~/workspace/wechat-bots/<botId8>/media/… Paths under
      // the legacy ~/workspace/wechat-media/ tree, anywhere else under
      // wechat-bots/ (e.g. convs/), or anywhere else at all are refused.
      const resolved = resolve(args.localPath);
      if (!resolved.startsWith(BOTS_ROOT_RESOLVED + sep)) return empty;
      const relParts = resolved
        .slice(BOTS_ROOT_RESOLVED.length + 1)
        .split(sep)
        .filter(Boolean);
      // Expected shape: [<botId8>, "media", ...file segments]
      if (relParts.length < 3 || relParts[1] !== "media") return empty;
      // Voice messages arrive as .silk, which browsers cannot play. When a
      // same-named .mp3 transcode sits beside it (produced by the bot's
      // media pipeline), serve that instead; without one, fall through and
      // serve the .silk itself as before.
      let target = resolved;
      if (/\.silk$/i.test(resolved)) {
        const mp3 = resolved.replace(/\.silk$/i, ".mp3");
        try {
          await stat(mp3);
          target = mp3;
        } catch {
          // no transcode — serve the original .silk below
        }
      }
      // Symlinks must not escape this bot's media folder: resolve the real
      // path of both the media dir and the (possibly transcoded) target and
      // require containment — the same check the save path in sendMedia
      // applies. A symlink inside media/ pointing outside is refused, even
      // though the lexical path above looked contained.
      const botId8 = relParts[0];
      if (!botId8) return empty;
      const mediaDir = join(BOTS_ROOT_RESOLVED, botId8, "media");
      let targetReal: string;
      try {
        const mediaDirReal = await realpath(mediaDir);
        targetReal = await realpath(target);
        if (!targetReal.startsWith(mediaDirReal + sep)) return empty;
      } catch {
        return empty;
      }
      target = targetReal;
      // Stat first: a non-file is refused outright, and an oversize file is
      // refused by size alone — not one byte of it is read into memory.
      let st;
      try {
        st = await stat(target);
      } catch {
        return empty;
      }
      if (!st.isFile()) return empty;
      if (st.size > MEDIA_MAX_BYTES) return { ...empty, size: st.size };
      let bytes: Buffer;
      try {
        bytes = await readFile(target);
      } catch {
        return empty;
      }
      return {
        found: true,
        dataBase64: bytes.toString("base64"),
        mimeType: mimeForPath(target),
        size: bytes.length,
        filename: basename(target),
      };
    },

    async sendMessage(args) {
      const text = args.text.trim();
      if (!text) return { ok: false, error: "消息不能为空" };
      if (text.length > MAX_SEND_CHARS) {
        return { ok: false, error: `消息太长，最多 ${MAX_SEND_CHARS} 字` };
      }
      const resolved = await resolveBotConversation(
        args.botId8,
        args.conversationSha,
      );
      if ("error" in resolved) return { ok: false, error: resolved.error };
      const { binding, folder } = resolved;
      const secret = await readBindingSecret(binding.id);
      if (secret === null) {
        return { ok: false, error: "机器人凭证缺失，无法发送" };
      }
      // Preferred path: the bot CLI (owns the iLink call + sent-log).
      const viaCli = await runCliSend(
        binding.id,
        binding.ownerExternalId,
        text,
      );
      if (viaCli.ok) {
        // Best-effort history record: the message already went out, so a
        // failed append must not report the send as failed.
        await appendAssistantLine(folder, text).catch(() => undefined);
        return { ok: true, error: null };
      }
      if (viaCli.ran) {
        // The CLI executed and the platform refused — no second attempt.
        return { ok: false, error: viaCli.error };
      }
      // The subprocess could not be executed at all — direct API fallback.
      const direct = await directSendText(
        secret,
        binding.ownerExternalId,
        text,
      );
      if (!direct.ok) return { ok: false, error: direct.error };
      await appendSentLog(binding.id, binding.ownerExternalId, text, direct.messageId);
      await appendAssistantLine(folder, text).catch(() => undefined);
      return { ok: true, error: null };
    },

    async sendMedia(args) {
      const noBytes = { compressed: false, originalBytes: 0, finalBytes: 0 };
      const caption = args.caption.trim();
      if (caption.length > MAX_SEND_CHARS) {
        return { ok: false, error: `消息太长，最多 ${MAX_SEND_CHARS} 字`, ...noBytes };
      }
      // Kind comes from the filename extension only; the client-sent
      // mimeType is a hint at most (browsers report "" for .silk).
      const dot = args.filename.lastIndexOf(".");
      const ext =
        dot > 0
          ? args.filename
              .slice(dot + 1)
              .toLowerCase()
              .replace(/[^a-z0-9]/g, "")
              .slice(0, 10)
          : "";
      // Voice can only be an existing .silk file — there is no mp3-to-silk
      // encoder (only a silk-to-mp3 decoder), so non-silk audio is refused
      // here instead of failing inside the upload.
      if (ext === "mp3") {
        return { ok: false, error: "语音只能发 .silk 文件，mp3 发不出去", ...noBytes };
      }
      if (AUDIO_EXTS.has(ext)) {
        return { ok: false, error: "语音只能发 .silk 文件，当前音频格式发不出去", ...noBytes };
      }
      const kind = inferMediaKind(ext);
      // Decode the base64 payload (tolerate an optional data: URI prefix).
      const b64 = args.dataBase64
        .replace(/^data:[^,]*;base64,/, "")
        .replace(/\s+/g, "");
      if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
        return { ok: false, error: "文件内容无效", ...noBytes };
      }
      const buf = Buffer.from(b64, "base64");
      if (buf.length === 0) {
        return { ok: false, error: "文件为空", ...noBytes };
      }
      const byteInfo = {
        compressed: false,
        originalBytes: buf.length,
        finalBytes: buf.length,
      };
      if (kind === "video" && buf.length > VIDEO_MAX_BYTES) {
        return {
          ok: false,
          error: "视频超过 5MB，平台发不出去，请压缩或裁剪后再发",
          ...byteInfo,
        };
      }
      if (kind !== "video" && buf.length > MEDIA_SEND_MAX_BYTES) {
        return { ok: false, error: "文件太大（超过 20MB），发不出去", ...byteInfo };
      }
      // The CLI re-checks this, but a clearer error here beats a failed
      // upload: a voice file must start with the SILK_V3 magic. Accept the
      // magic at offset 0 or 1 (real WeChat silk files carry a leading
      // 0x02 byte) — the same rule the CLI's fixed check applies.
      if (kind === "voice") {
        const head = buf.subarray(0, 10).toString("ascii");
        if (!head.startsWith("#!SILK_V3") && !head.slice(1).startsWith("#!SILK_V3")) {
          return {
            ok: false,
            error: "语音只能发 .silk 文件，当前文件不是有效的 .silk 格式",
            ...byteInfo,
          };
        }
      }
      const resolved = await resolveBotConversation(
        args.botId8,
        args.conversationSha,
      );
      if ("error" in resolved) return { ok: false, error: resolved.error, ...byteInfo };
      const { binding, folder } = resolved;
      const botId8 = binding.id.slice(0, 8);
      // Save under this bot's own media root, in a per-day folder — the
      // CLI's send-media hard check requires exactly this containment.
      const mediaRoot = join(BOTS_ROOT, botId8, "media");
      const mediaDateDir = join(mediaRoot, beijingDateString());
      let mediaRootReal: string;
      try {
        await mkdir(mediaDateDir, { recursive: true });
        mediaRootReal = await realpath(mediaRoot);
      } catch (e) {
        return {
          ok: false,
          error: `保存文件失败：${e instanceof Error ? e.message : String(e)}`,
          ...byteInfo,
        };
      }
      const safeName = `${kind}-${Date.now()}-${randomBytes(4).toString("hex")}${ext ? `.${ext}` : ""}`;
      let savedPath = resolve(join(mediaDateDir, safeName));
      if (!savedPath.startsWith(mediaRootReal + sep)) {
        return { ok: false, error: "文件名不合法", ...byteInfo };
      }
      try {
        await writeFile(savedPath, buf);
        const realSaved = await realpath(savedPath);
        if (!realSaved.startsWith(mediaRootReal + sep)) {
          return { ok: false, error: "文件名不合法", ...byteInfo };
        }
      } catch (e) {
        return {
          ok: false,
          error: `保存文件失败：${e instanceof Error ? e.message : String(e)}`,
          ...byteInfo,
        };
      }
      // Large images: compress in place BEFORE the CLI upload — above
      // ~250 KB the platform CDN rejects the upload (HTTP 500) after a
      // long wait. Only images are compressed; video/voice/file go as-is.
      let compressed = false;
      let finalBytes = buf.length;
      if (kind === "image" && buf.length > IMAGE_COMPRESS_THRESHOLD_BYTES) {
        const comp = await compressImageFile(savedPath);
        if (!comp.ok) {
          return {
            ok: false,
            error: `图片太大（${Math.round(buf.length / 1024)} KB），自动压缩失败：${comp.error}。请换一张小一点的图片再发`,
            compressed: false,
            originalBytes: buf.length,
            finalBytes: buf.length,
          };
        }
        // The compressed file must still live inside this bot's own media
        // root (a PNG converted to JPEG changes the extension, not the dir).
        const realComp = await realpath(comp.path).catch(() => "");
        if (!realComp || !realComp.startsWith(mediaRootReal + sep)) {
          return {
            ok: false,
            error: "图片太大，自动压缩失败：压缩后的文件位置不合法。请换一张小一点的图片再发",
            compressed: false,
            originalBytes: buf.length,
            finalBytes: buf.length,
          };
        }
        savedPath = realComp;
        compressed = true;
        finalBytes = comp.size;
      }
      const sendInfo = {
        compressed,
        originalBytes: buf.length,
        finalBytes,
      };
      // The CLI owns the upload + send + sent-log. No direct-API fallback
      // here: re-implementing the CDN upload (presigned URL + AES
      // encryption) is error-prone, and the CLI is proven to work.
      const sent = await runCliSendMedia(
        binding.id,
        binding.ownerExternalId,
        savedPath,
        kind,
        caption,
      );
      if (!sent.ok) {
        // The file is saved but was not sent; leave it in the bot's media
        // dir (harmless) and report the failure honestly.
        return { ok: false, error: sent.error, ...sendInfo };
      }
      // Best-effort history record: the message already went out, so a
      // failed append must not report the send as failed. The caption (if
      // any) was sent first by the CLI as its own text message, so it is
      // recorded first, then the media line — pointing at the file that
      // was actually sent (the compressed one, when compression ran).
      if (caption) {
        await appendAssistantLine(folder, caption).catch(() => undefined);
      }
      await appendAssistantMediaLine(folder, kind, savedPath).catch(
        () => undefined,
      );
      return { ok: true, error: null, ...sendInfo };
    },

    async setPaused(args) {
      const resolved = await resolveBotConversation(
        args.botId8,
        args.conversationSha,
      );
      if ("error" in resolved) {
        return { paused: false, error: resolved.error };
      }
      const flag = pausedFlagPath(args.botId8, resolved.sha);
      try {
        await mkdir(HOOKS_STATE_DIR, { recursive: true });
        if (args.paused) {
          await writeFile(flag, "", "utf8");
        } else {
          await rm(flag, { force: true });
        }
      } catch (e) {
        return {
          paused: await pausedExists(args.botId8, resolved.sha),
          error: `切换失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return {
        paused: await pausedExists(args.botId8, resolved.sha),
        error: null,
      };
    },

    async getPaused(args) {
      const resolved = await resolveBotConversation(
        args.botId8,
        args.conversationSha,
      );
      if ("error" in resolved) {
        return { paused: false, error: resolved.error };
      }
      return {
        paused: await pausedExists(args.botId8, resolved.sha),
        error: null,
      };
    },
  },
);
