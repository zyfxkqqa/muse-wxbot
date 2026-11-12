#!/usr/bin/env node
/**
 * wechat-bot CLI — provision WeChat ClawBots (via Tencent iLink), check status,
 * send text messages and media (image/video/voice/file via CDN upload), and
 * poll incoming messages. All output is JSON lines.
 * Supports multiple bound bots: pass --bot <index|id-prefix|name|label> to
 * target one bot (default: the first bound bot).
 *
 *   wechat-bot provision [--label <name>]   # print QR, wait for WeChat scan, save binding
 *   wechat-bot status                       # list bound bots
 *   wechat-bot set-label --bot <sel> --label <name>
 *   wechat-bot send --to <id> --text <text> [--context-token <token>] [--bot <sel>] [--actor manual|worker|viewer]
 *   wechat-bot send-media --to <id> --file <path> [--kind image|video|voice|file] [--text <caption>] [--bot <sel>] [--actor manual|worker|viewer]
 *   wechat-bot poll [--timeout-ms <ms>] [--bot <sel>]
 *   wechat-bot poll-all [--timeout-ms <ms>] # one JSON line per bot
 *   wechat-bot notify-start [--bot <sel>]
 *   wechat-bot notify-stop [--bot <sel>]
 */
import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FsWechatBotStore,
  WechatBotBinding,
  WechatClawbotApi,
  WechatClawbotProvisioner,
  WechatMessageItem
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, "..");
const bindingFile = join(skillDir, "state", "bindings.json");
const sentLogFile = join(skillDir, "state", "sent-log.jsonl");
// Marker the inbox worker checks: presence means the intro has not been
// delivered for this bot yet. The worker sends it (intro first, then the
// reply) on the bound account's first message and deletes the marker.
const hooksStateDir = join(process.env.HOME ?? "", "hooks", "state");

function emit(obj: unknown) {
  console.log(JSON.stringify(obj));
}

// P1-17 (2026-11-12): sent-log carries metadata only — never message
// text. Both write sites (cmdSend, cmdSendMedia) go through this helper
// so no call site can reintroduce a `text` field. Fields kept: ts, botId,
// to, kind, file, actor, messageId (+ captionFailed/error markers).
async function appendSentLog(entry: Record<string, unknown>): Promise<void> {
  await appendFile(sentLogFile, JSON.stringify(entry) + "\n", "utf8").catch(() => undefined);
  await chmod(sentLogFile, 0o600).catch(() => undefined);
}

function fail(message: string): never {
  emit({ type: "error", message });
  process.exit(1);
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

// P9 (L8): --timeout-ms / --limit must be a finite number. A non-numeric
// value used to silently become NaN (provision timed out instantly, poll
// lost its timeout entirely, sent-log returned every record).
function finiteNumber(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${flag} 必须是数字，收到 "${raw}"`);
  return n;
}

// 2026-11-12 (C 4b): who sent this message — recorded in sent-log so a
// record can be told apart as manual / worker / viewer. Default manual
// (CLI invoked by a human); the inbox worker passes --actor worker.
function actorFlag(): "manual" | "worker" | "viewer" {
  const raw = arg("--actor");
  if (raw === undefined) return "manual";
  if (raw === "manual" || raw === "worker" || raw === "viewer") return raw;
  fail(`--actor 必须是 manual|worker|viewer，收到 "${raw}"`);
}

function botLabel(bot: WechatBotBinding): string {
  const meta = (bot.metadata ?? {}) as Record<string, unknown>;
  const label = typeof meta.label === "string" ? meta.label.trim() : "";
  return label || bot.displayName || bot.id.slice(0, 8);
}

async function selectBot(store: FsWechatBotStore): Promise<WechatBotBinding> {
  const bots = await store.listActive();
  if (bots.length === 0) fail("no bound WeChat bot — run `wechat-bot provision` first");
  const sel = arg("--bot");
  if (!sel) return bots[0];
  const norm = sel.trim().toLowerCase();
  const idx = Number(norm);
  // P9 (L12): a purely numeric selector that is out of range is an error,
  // not a fuzzy match — "--bot 0" must never fall through to substring
  // matching and land on a bot whose label happens to contain "0".
  if (/^-?\d+$/.test(norm)) {
    if (Number.isInteger(idx) && idx >= 1 && idx <= bots.length) return bots[idx - 1];
    fail(`--bot "${sel}" 超出范围（共 ${bots.length} 个机器人，编号 1–${bots.length}）`);
  }
  const found = bots.find(
    (b) =>
      b.id.toLowerCase().startsWith(norm) ||
      (b.displayName ?? "").toLowerCase().includes(norm) ||
      botLabel(b).toLowerCase().includes(norm)
  );
  if (!found) fail(`no bot matches --bot "${sel}" (run status to list bots)`);
  return found;
}

async function cmdProvision() {
  const store = new FsWechatBotStore(bindingFile);
  const api = new WechatClawbotApi();
  const provisioner = new WechatClawbotProvisioner({ api, store });
  const timeoutMs = finiteNumber(arg("--timeout-ms"), 8 * 60 * 1000, "timeout-ms");
  const label = arg("--label")?.trim();
  let qrEmitted = false;
  const bot = await provisioner.createBot({
    timeoutMs,
    onStatus: (s) => {
      if (s.phase === "WECHAT_WAITING_FOR_SCAN" && s.qrImageDataUrl && !qrEmitted) {
        qrEmitted = true;
        emit({ type: "qr", qrUrl: s.qrImageDataUrl, qrValue: s.qrValue ?? "" });
      } else if (s.phase !== "WECHAT_WAITING_FOR_SCAN") {
        emit({ type: "status", phase: s.phase, message: s.message ?? "" });
      }
    }
  });
  if (label) {
    bot.metadata = { ...(bot.metadata ?? {}), label };
    await store.save(bot);
  }
  await chmod(bindingFile, 0o600).catch(() => undefined);
  // No greeting is sent at binding time: the platform does not deliver a
  // bot's message before the bound account has messaged it first (proven
  // 2026-11-10 — greetings at +1s and +5s after binding, and a test send
  // ~2min after binding, were all accepted by the API but never arrived;
  // only sends after the user messages first arrive). The binding-time
  // auto-send was deleted 2026-11-10. Only mark the intro as pending: the
  // worker delivers it on the bound account's first message (intro first,
  // then the reply) and clears this marker. See the hook prompt
  // ("先判断要不要先发介绍").
  const markerFile = join(hooksStateDir, `wechat-intro-pending.${bot.id.slice(0, 8)}`);
  await writeFile(markerFile, "", "utf8").catch(() => undefined);
  emit({ type: "confirmed", botId: bot.id, botLabel: botLabel(bot), displayName: bot.displayName });
}

async function cmdStatus() {
  const store = new FsWechatBotStore(bindingFile);
  const bots = await store.listActive();
  emit({
    type: "status",
    connected: bots.length > 0,
    bots: bots.map((b: WechatBotBinding, i: number) => ({
      index: i + 1,
      id: b.id,
      label: botLabel(b),
      displayName: b.displayName,
      platformBotId: b.platformBotId,
      createdAt: b.createdAt,
      lastError: (b.metadata as Record<string, unknown> | undefined)?.lastError ?? null
    }))
  });
}

async function cmdSetLabel() {
  const label = arg("--label")?.trim();
  if (!label) fail("missing --label <name>");
  const store = new FsWechatBotStore(bindingFile);
  const bot = await selectBot(store);
  bot.metadata = { ...(bot.metadata ?? {}), label };
  await store.save(bot);
  await chmod(bindingFile, 0o600).catch(() => undefined);
  emit({ type: "labeled", botId: bot.id, botLabel: label });
}

async function cmdSend() {
  const to = arg("--to");
  const text = arg("--text");
  const contextToken = arg("--context-token") ?? undefined;
  if (!to) fail("missing --to <userId>");
  if (!text) fail("missing --text <text>");
  // Validate --actor BEFORE any network call: a bad value must fail
  // without sending.
  const actor = actorFlag();
  const store = new FsWechatBotStore(bindingFile);
  const bot = await selectBot(store);
  const api = new WechatClawbotApi();
  // 2026-11-12 (C 5b): keep sendText's returned message_id so the sent-log
  // record can be reconciled against the platform side, like media does.
  const sent = await api.sendText({ baseUrl: bot.baseUrl, token: bot.token, toUserId: to, text, contextToken });
  // Auto-log every sent message so mirror records never rely on memory.
  // P1-17: metadata only — no `text` field (the full message body must
  // never land in sent-log, which is copied into backups and packages).
  await appendSentLog({
    ts: new Date().toISOString(),
    botId: bot.id,
    to,
    kind: "text",
    actor,
    ...(sent.message_id ? { messageId: sent.message_id } : {})
  });
  emit({ type: "sent", to, botId: bot.id, botLabel: botLabel(bot) });
}

// Per-bot isolation (Scheme B): resolve a directory to its canonical path.
// If the directory itself does not exist yet, resolve the nearest existing
// ancestor and append the rest, so a symlinked HOME/workspace still compares
// equal to a realpath'd file.
async function canonicalDir(dir: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  const { basename, dirname, join, resolve } = await import("node:path");
  try {
    return await realpath(dir);
  } catch {
    const parent = dirname(dir);
    if (parent === dir) return resolve(dir);
    return join(await canonicalDir(parent), basename(dir));
  }
}

// Send a media file (image/video/voice/file) to a WeChat user via a
// specific bot. Flow mirrors upstream openclaw-weixin: upload the file to
// the iLink CDN first (getUploadUrl + AES-128-ECB encrypt + POST ciphertext),
// then send one message whose item_list carries the CDN reference. The
// optional --text caption is sent first as its own text message, like
// upstream sendMediaItems. Voice files must already be SILK-encoded (.silk).
async function cmdSendMedia() {
  const to = arg("--to");
  const file = arg("--file");
  const kindArg = arg("--kind");
  const text = arg("--text") ?? undefined;
  const contextToken = arg("--context-token") ?? undefined;
  if (!to) fail("missing --to <userId>");
  if (!file) fail("missing --file <path>");
  // Validate --actor BEFORE upload/send: a bad value must fail without
  // uploading or sending anything.
  const actor = actorFlag();
  const store = new FsWechatBotStore(bindingFile);
  const bot = await selectBot(store);
  const { stat, readFile: readFileBuf, realpath } = await import("node:fs/promises");
  const { basename, extname, join, resolve, sep } = await import("node:path");
  // Per-bot isolation (Scheme B): a bot may only send files from its own
  // media directory (~/workspace/wechat-bots/<botId8>/media). Resolve
  // symlinks on both sides first, so a symlink or `..` escape cannot
  // smuggle another bot's file out.
  const botMediaRoot = await canonicalDir(
    resolve(join(process.env.HOME ?? "", "workspace", "wechat-bots", bot.id.slice(0, 8), "media"))
  );
  let realFile: string;
  try {
    realFile = await realpath(file);
  } catch {
    fail(`file not found: ${file}`);
  }
  if (!realFile!.startsWith(botMediaRoot + sep)) {
    fail(`file is not in this bot's media directory (${botMediaRoot}): ${file}`);
  }
  let st;
  try {
    st = await stat(realFile!);
  } catch {
    fail(`file not found: ${file}`);
  }
  if (!st!.isFile()) fail(`not a file: ${file}`);
  const kindByExt: Record<string, string> = {
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
    ".gif": "image",
    ".bmp": "image",
    ".webp": "image",
    ".mp4": "video",
    ".mov": "video",
    ".silk": "voice"
  };
  const kind = kindArg ?? kindByExt[extname(file).toLowerCase()] ?? "file";
  if (!["image", "video", "voice", "file"].includes(kind)) fail(`bad --kind ${kind} (image|video|voice|file)`);
  // P9 (L9): CLI-side size caps aligned with the SKILL.md measured values
  // (video ≤4.6MB works / ≥5.5MB CDN 500, keep under ~5MB; other files
  // 20MB like the viewer). Images are NOT capped here: the measured
  // image threshold is only known to lie between ~246KB and ~529KB, and
  // the viewer already auto-compresses images to ≤250KB before calling
  // the CLI — a hard CLI cap would reject images that might still send.
  if (kind === "video" && st!.size > 5 * 1024 * 1024) {
    fail(`视频文件超过 5MB 上限（${st!.size} 字节），请先压缩再发送`);
  }
  if (kind === "file" && st!.size > 20 * 1024 * 1024) {
    fail(`文件超过 20MB 上限（${st!.size} 字节）`);
  }
  const buf = await readFileBuf(realFile!);
  // SILK magic is "#!SILK_V3". Real WeChat voice files carry a 0x02 byte
  // before it, so the magic sits at offset 1. Accept either offset.
  const head = buf.subarray(0, 10).toString("ascii");
  const isSilk = head.startsWith("#!SILK_V3") || head.startsWith("\x02#!SILK_V3");
  if (kind === "voice" && !isSilk) {
    fail("voice file must be SILK-encoded (.silk)");
  }
  const mediaType = { image: 1, video: 2, file: 3, voice: 4 }[kind as "image" | "video" | "file" | "voice"];
  const api = new WechatClawbotApi();
  const up = await api.uploadMedia({ baseUrl: bot.baseUrl, token: bot.token, filePath: realFile!, mediaType, toUserId: to });
  // aes_key is base64 of the 32-char hex key string (platform format 3 —
  // the same format cmdDownloadMedia already accepts when receiving).
  const media = {
    encrypt_query_param: up.downloadEncryptedQueryParam,
    aes_key: Buffer.from(up.aeskeyHex).toString("base64"),
    encrypt_type: 1
  };
  let item: WechatMessageItem;
  if (kind === "image") item = { type: 2, image_item: { media, mid_size: up.fileSizeCiphertext } };
  else if (kind === "video") item = { type: 5, video_item: { media, video_size: up.fileSizeCiphertext } };
  else if (kind === "voice") item = { type: 3, voice_item: { media, encode_type: 6 } };
  else item = { type: 4, file_item: { media, file_name: basename(file), len: String(up.fileSize) } };
  // P9 (L9): upload happens first (above), and the media item is sent
  // BEFORE the caption — if the media send fails, no orphan caption is
  // ever delivered. Previously the caption went first, so a media failure
  // left the recipient with a caption pointing at nothing.
  const sent = await api.sendItem({ baseUrl: bot.baseUrl, token: bot.token, toUserId: to, contextToken, item });
  // P1-11: log the media send IMMEDIATELY after sendItem succeeds — the
  // media is already delivered at this point. If the caption below fails,
  // the media record must survive; only a caption-failed marker is added
  // (P1-17: metadata only, no caption `text` in either record).
  const mediaEntry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    botId: bot.id,
    to,
    kind,
    file,
    actor,
    ...(sent.message_id ? { messageId: sent.message_id } : {})
  };
  await appendSentLog(mediaEntry);
  if (text) {
    try {
      await api.sendText({ baseUrl: bot.baseUrl, token: bot.token, toUserId: to, text, contextToken });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await appendSentLog({
        ...mediaEntry,
        ts: new Date().toISOString(),
        captionFailed: true,
        error: errMsg
      });
      fail(`媒体已发出，仅配文失败，勿重发：${errMsg}`);
    }
  }
  emit({ type: "sent-media", to, botId: bot.id, botLabel: botLabel(bot), kind, file });
}

async function cmdSentLog() {
  const to = arg("--to");
  if (!to) fail("missing --to <userId>");
  const limit = Math.max(1, finiteNumber(arg("--limit"), 50, "limit"));
  const store = new FsWechatBotStore(bindingFile);
  const bot = await selectBot(store);
  let lines: string[] = [];
  try {
    const raw = await readFile(sentLogFile, "utf8");
    lines = raw.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    lines = [];
  }
  interface SentEntry {
    ts: string;
    botId: string;
    to: string;
    text?: string;
    kind?: string;
    file?: string;
    actor?: string;
    messageId?: string;
  }
  const mine: SentEntry[] = [];
  for (const l of lines) {
    let e: SentEntry | null = null;
    try {
      e = JSON.parse(l) as SentEntry;
    } catch {
      e = null;
    }
    if (e && e.botId === bot.id && e.to === to) mine.push(e);
  }
  // P9 (L14): include kind/file so media sends are identifiable, and
  // always emit text ("" when the record has none) instead of dropping
  // the field from the JSON output.
  for (const e of mine.slice(-limit)) {
    emit({ type: "sent-log", ts: e.ts, to: e.to, text: e.text ?? "", kind: e.kind ?? null, file: e.file ?? null, actor: e.actor ?? null, messageId: e.messageId ?? null });
  }
}

interface PolledMedia {
  kind: "image" | "voice" | "video" | "file";
  fileName?: string;
  voiceText?: string;
  aesKey?: string;
  fullUrl?: string;
  encryptedQueryParam?: string;
}

interface PolledMessage {
  fromUserId: string;
  sessionId: string;
  messageId: string;
  text: string;
  media: PolledMedia[];
  contextToken: string;
}

async function pollBot(
  api: WechatClawbotApi,
  bot: WechatBotBinding,
  timeoutMs: number
): Promise<
  | { ok: true; messages: PolledMessage[]; bot: WechatBotBinding; cursorUpdated: boolean }
  | { ok: false; messages: []; error: string; bot: WechatBotBinding; cursorUpdated: boolean }
> {
  const buf = ((bot.metadata as Record<string, unknown> | undefined)?.getUpdatesBuf as string) ?? "";
  let res;
  try {
    res = await api.getUpdates({
      baseUrl: bot.baseUrl,
      token: bot.token,
      getUpdatesBuf: buf,
      timeoutMs
    });
  } catch (error) {
    // Our own long-poll timeout firing with no new messages is the normal
    // idle case, not a failure.
    if (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))) {
      return { ok: true, messages: [], bot, cursorUpdated: false };
    }
    return {
      ok: false,
      messages: [],
      error: error instanceof Error ? error.message : String(error),
      bot,
      cursorUpdated: false
    };
  }
  // P6 (M4/M5): check ret AND errcode (mirroring the provisioner's
  // pollLoop) BEFORE adopting the cursor. An error response must never
  // advance the cursor — otherwise its batch of messages is silently
  // skipped on the next poll.
  if (res.ret !== undefined && res.ret !== 0) {
    return {
      ok: false,
      messages: [],
      error: `getupdates ret=${res.ret} errcode=${res.errcode ?? "?"} ${res.errmsg ?? ""}`.trim(),
      bot,
      cursorUpdated: false
    };
  }
  if (res.errcode !== undefined && res.errcode !== 0) {
    return {
      ok: false,
      messages: [],
      error: `getupdates errcode=${res.errcode} ${res.errmsg ?? ""}`.trim(),
      bot,
      cursorUpdated: false
    };
  }
  let cursorUpdated = false;
  if (res.get_updates_buf) {
    bot.metadata = { ...(bot.metadata ?? {}), getUpdatesBuf: res.get_updates_buf };
    cursorUpdated = true;
  }
  const mapped = (res.msgs ?? [])
    .filter((m) => m.message_type !== 2) // type 2 = bot's own outgoing messages
    .map((m) => {
      const media: PolledMedia[] = [];
      let text = "";
      const unknownItemTypes: number[] = [];
      for (const i of m.item_list ?? []) {
        const t = i.type ?? 0;
        if (t === 1) {
          text += i.text_item?.text ?? "";
        } else if (t === 2 && i.image_item?.media) {
          const md = i.image_item.media;
          media.push({ kind: "image", aesKey: md.aes_key, fullUrl: md.full_url, encryptedQueryParam: md.encrypted_query_param });
        } else if (t === 3 && i.voice_item) {
          const md = i.voice_item.media;
          media.push({ kind: "voice", voiceText: i.voice_item.text ?? md?.text, aesKey: md?.aes_key, fullUrl: md?.full_url, encryptedQueryParam: md?.encrypted_query_param });
        } else if (t === 4 && i.file_item) {
          const md = i.file_item.media;
          media.push({ kind: "file", fileName: i.file_item.file_name, aesKey: md?.aes_key, fullUrl: md?.full_url, encryptedQueryParam: md?.encrypted_query_param });
        } else if (t === 5 && i.video_item?.media) {
          const md = i.video_item.media;
          media.push({ kind: "video", aesKey: md.aes_key, fullUrl: md.full_url, encryptedQueryParam: md.encrypted_query_param });
        } else {
          unknownItemTypes.push(t);
        }
      }
      // P9 (L13): never silently drop a message of unknown type — log one
      // structured line per unknown item (stderr, so stdout stays JSON
      // lines for the hook) so the hook/operator can see it.
      for (const t of unknownItemTypes) {
        console.error(
          JSON.stringify({
            type: "poll-unknown-item",
            botId: bot.id,
            fromUserId: m.from_user_id ?? "",
            messageId: String(m.message_id ?? m.client_id ?? ""),
            seq: typeof m.seq === "number" ? m.seq : null,
            itemType: t
          })
        );
      }
      return {
        fromUserId: m.from_user_id ?? "",
        sessionId: m.session_id ?? m.from_user_id ?? "",
        messageId: String(m.message_id ?? m.client_id ?? ""),
        seq: typeof m.seq === "number" ? m.seq : 0,
        text: text.trim(),
        media,
        contextToken: m.context_token ?? "",
        _unknownItemTypes: unknownItemTypes
      };
    });
  const messages = mapped
    .filter((m) => {
      const keep = m.fromUserId && (m.text || m.media.length > 0);
      if (!keep) {
        console.error(
          JSON.stringify({
            type: "poll-dropped-message",
            botId: bot.id,
            fromUserId: m.fromUserId,
            messageId: m.messageId,
            seq: m.seq,
            unknownItemTypes: m._unknownItemTypes
          })
        );
      }
      return keep;
    })
    .map(({ _unknownItemTypes, ...rest }) => rest);
  return { ok: true, messages, bot, cursorUpdated };
}

// Persist one bot's cursor. Must be called SEQUENTIALLY (never concurrently):
// FsWechatBotStore.save is read-modify-write on the shared bindings file.
async function saveCursor(store: FsWechatBotStore, bot: WechatBotBinding): Promise<void> {
  try {
    await store.save(bot);
    await chmod(bindingFile, 0o600).catch(() => undefined);
  } catch (error) {
    // 2026-11-12 (C 5c): never fail silently — log one structured line
    // (stderr, so stdout stays JSON lines). Still do NOT throw: a failed
    // cursor save only means the next poll re-fetches, no message is lost.
    console.error(
      JSON.stringify({
        type: "save-cursor-failed",
        botId: bot.id,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }
}

async function cmdPoll() {
  const store = new FsWechatBotStore(bindingFile);
  const bot = await selectBot(store);
  const api = new WechatClawbotApi();
  const timeoutMs = finiteNumber(arg("--timeout-ms"), 35_000, "timeout-ms");
  const r = await pollBot(api, bot, timeoutMs);
  // P6 (M5): only persist the cursor on success — pollBot already refuses
  // to adopt a cursor from an error response, this is defence in depth.
  if (r.ok && r.cursorUpdated) await saveCursor(store, r.bot);
  // P4 (M8): single-bot poll records lastError too, like poll-all — the
  // hook polls one bot at a time, so without this `status` lastError could
  // never be set by the hook's own poll failures.
  if (!r.ok) {
    try {
      await store.markError?.(bot.id, r.error);
    } catch {
      /* ignore */
    }
    fail(r.error);
  }
  // Fetch succeeded: clear any previously recorded error so the status
  // auto-recovers once the bot is healthy again.
  try {
    await store.clearError?.(bot.id);
  } catch {
    /* ignore */
  }
  const label = botLabel(bot);
  emit({
    type: "messages",
    botId: bot.id,
    botLabel: label,
    count: r.messages.length,
    messages: r.messages.map((m) => ({ ...m, botId: bot.id, botLabel: label }))
  });
}

async function cmdPollAll() {
  const store = new FsWechatBotStore(bindingFile);
  const bots = await store.listActive();
  if (bots.length === 0) fail("no bound WeChat bot — run `wechat-bot provision` first");
  const api = new WechatClawbotApi();
  const timeoutMs = finiteNumber(arg("--timeout-ms"), 15_000, "timeout-ms");
  // Poll all bots CONCURRENTLY: one 6s long-poll round covers every bot, no
  // matter how many are bound. Cursor saves below stay sequential.
  const results = await Promise.all(
    bots.map(async (bot) => {
      const label = botLabel(bot);
      const r = await pollBot(api, bot, timeoutMs);
      return { bot, label, r };
    })
  );
  for (const { bot, label, r } of results) {
    // P6 (M5): only persist the cursor on success (see cmdPoll).
    if (r.ok && r.cursorUpdated) await saveCursor(store, r.bot);
    if (!r.ok) {
      try {
        await store.markError?.(bot.id, r.error);
      } catch {
        /* ignore */
      }
      emit({ type: "error", botId: bot.id, botLabel: label, message: r.error });
      continue;
    }
    // Fetch succeeded: clear any previously recorded error so the status
    // auto-recovers once the bot is healthy again.
    try {
      await store.clearError?.(bot.id);
    } catch {
      /* ignore */
    }
    emit({
      type: "messages",
      botId: bot.id,
      botLabel: label,
      count: r.messages.length,
      messages: r.messages.map((m) => ({ ...m, botId: bot.id, botLabel: label }))
    });
  }
}

async function cmdNotifyStart() {
  const store = new FsWechatBotStore(bindingFile);
  const bot = await selectBot(store);
  const api = new WechatClawbotApi();
  const res = await api.notifyStart({ baseUrl: bot.baseUrl, token: bot.token });
  if (res.ret !== undefined && res.ret !== 0) fail(`notifystart failed: ret=${res.ret} ${res.errmsg ?? ""}`);
  emit({ type: "notified", event: "start", botId: bot.id, botLabel: botLabel(bot) });
}

async function cmdNotifyStop() {
  const store = new FsWechatBotStore(bindingFile);
  const bot = await selectBot(store);
  const api = new WechatClawbotApi();
  const res = await api.notifyStop({ baseUrl: bot.baseUrl, token: bot.token });
  if (res.ret !== undefined && res.ret !== 0) fail(`notifystop failed: ret=${res.ret} ${res.errmsg ?? ""}`);
  emit({ type: "notified", event: "stop", botId: bot.id, botLabel: botLabel(bot) });
}

async function cmdDownloadMedia() {
  const aesKey = arg("--aes-key");
  const fullUrl = arg("--full-url");
  const encParam = arg("--enc-param");
  const out = arg("--out");
  if (!aesKey) fail("missing --aes-key");
  if (!out) fail("missing --out");
  const url = fullUrl || (encParam ? `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(encParam)}` : "");
  if (!url) fail("missing --full-url or --enc-param");

  // P9 (L10): 30s timeout per attempt and up to 3 attempts with backoff
  // (1s, 2s) — previously a hung CDN or one bad fetch left the whole
  // download to the hook's outer retry loop with no CLI-side retry.
  // P1-9/P1-10 (2026-11-12): total budget of 90s for the whole call —
  // per-attempt timeout and backoff sleep are both capped by the
  // remaining budget, so one CLI invocation can no longer run the full
  // 3x30s + backoff (~93s). Internal 3-attempt retry is kept; the hook
  // layer adds its own per-file total limit on top (try_download). This
  // is the CLI-side convergence point only.
  const DOWNLOAD_TOTAL_TIMEOUT_MS = 90_000;
  const downloadDeadline = Date.now() + DOWNLOAD_TOTAL_TIMEOUT_MS;
  let encBuf: Buffer | null = null;
  let lastDownloadError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (downloadDeadline - Date.now() <= 0) {
      lastDownloadError = new Error(`download timed out after ${DOWNLOAD_TOTAL_TIMEOUT_MS}ms total`);
      break;
    }
    if (attempt > 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 2), Math.max(0, downloadDeadline - Date.now())))
      );
      if (downloadDeadline - Date.now() <= 0) {
        lastDownloadError = new Error(`download timed out after ${DOWNLOAD_TOTAL_TIMEOUT_MS}ms total`);
        break;
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(30_000, downloadDeadline - Date.now()));
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      encBuf = Buffer.from(await res.arrayBuffer());
      break;
    } catch (error) {
      lastDownloadError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!encBuf) {
    fail(
      lastDownloadError instanceof Error
        ? `download failed after 3 attempts: ${lastDownloadError.message}`
        : "download failed after 3 attempts"
    );
  }

  // aes_key 可能是三种格式：
  //   1. base64(16字节)；2. 32位hex字符串；3. base64(32位hex字符串)
  // 平台实际下发的是第3种（把32位hex串又包了一层base64），之前只认前两种，
  // 导致所有图片/语音自动下载失败（bad aes key length）。
  let keyBuf: Buffer | null = null;
  const asB64 = Buffer.from(aesKey, "base64");
  if (asB64.length === 16) {
    keyBuf = asB64;
  } else if (asB64.length === 32 && /^[0-9a-fA-F]{32}$/.test(asB64.toString("utf8"))) {
    keyBuf = Buffer.from(asB64.toString("utf8"), "hex");
  } else if (/^[0-9a-fA-F]{32}$/.test(aesKey.trim())) {
    keyBuf = Buffer.from(aesKey.trim(), "hex");
  }
  if (!keyBuf || keyBuf.length !== 16) fail(`bad aes key length: ${keyBuf ? keyBuf.length : 0}`);

  const { createDecipheriv } = await import("node:crypto");
  const decipher = createDecipheriv("aes-128-ecb", keyBuf, null);
  decipher.setAutoPadding(true);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(encBuf), decipher.final()]);
  } catch (error) {
    // P9 (L10): wrap the raw crypto error — a failed final() means the
    // aes-key and the CDN ciphertext do not match, which the raw error
    // never says.
    fail(`解密失败：aes-key 或 CDN 数据不匹配（${error instanceof Error ? error.message : String(error)}）`);
  }
  const { writeFile, rename } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(out), { recursive: true });
  // Atomic write: land under a temp name first and rename only on success,
  // so a half-written file can never pose as a completed download.
  // (The hook's try_download also stages via ${out}.part before renaming.)
  const tmp = `${out}.part`;
  await writeFile(tmp, plain);
  await rename(tmp, out);
  emit({ type: "download-media", out, bytes: plain.length });
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === "provision") await cmdProvision();
    else if (cmd === "status") await cmdStatus();
    else if (cmd === "set-label") await cmdSetLabel();
    else if (cmd === "send") await cmdSend();
    else if (cmd === "send-media") await cmdSendMedia();
    else if (cmd === "sent-log") await cmdSentLog();
    else if (cmd === "poll") await cmdPoll();
    else if (cmd === "poll-all") await cmdPollAll();
    else if (cmd === "notify-start") await cmdNotifyStart();
    else if (cmd === "notify-stop") await cmdNotifyStop();
    else if (cmd === "download-media") await cmdDownloadMedia();
    else
      fail(
        `unknown command: ${cmd ?? "(none)"} — use provision|status|set-label|send|send-media|sent-log|poll|poll-all|notify-start|notify-stop|download-media`
      );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

void main();
