#!/usr/bin/env node
/**
 * wechat-bot CLI — provision WeChat ClawBots (via Tencent iLink), check status,
 * send text messages, and poll incoming messages. All output is JSON lines.
 * Supports multiple bound bots: pass --bot <index|id-prefix|name|label> to
 * target one bot (default: the first bound bot).
 *
 *   wechat-bot provision [--label <name>]   # print QR, wait for WeChat scan, save binding
 *   wechat-bot status                       # list bound bots
 *   wechat-bot set-label --bot <sel> --label <name>
 *   wechat-bot send --to <id> --text <text> [--bot <sel>]
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
  WechatClawbotProvisioner
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

function fail(message: string): never {
  emit({ type: "error", message });
  process.exit(1);
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
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
  if (Number.isInteger(idx) && idx >= 1 && idx <= bots.length) return bots[idx - 1];
  const found = bots.find(
    (b) =>
      b.id.toLowerCase().startsWith(norm) ||
      (b.displayName ?? "").toLowerCase().includes(norm) ||
      botLabel(b).toLowerCase().includes(norm)
  );
  if (!found) fail(`no bot matches --bot "${sel}" (run status to list bots)`);
  return found;
}

// Binding greeting: sent automatically by the program itself right after a
// new bot is bound, to the account that just bound it (bot.ownerExternalId).
// Keep this text in sync with the greeting in hooks/worker-prompt.md.
const BINDING_GREETING = [
  "你好呀，我是 Muse，用户的个人助理，你说的事我会记在当前对话里，不用重复说。",
  "我能帮你：",
  "聊天、回答问题",
  "写东西、改文字、翻译",
  "总结归纳、出主意、做计划",
  "操作：",
  "帮助 — 看指令清单",
  "新建对话 — 开始一个新对话，之前的就不记得了",
  "切换对话 — 看你的对话清单，切回以前的对话",
  "修改旁聊名称 新名字 — 给当前对话改名",
  "直接发消息就能聊。"
].join("\n");

async function cmdProvision() {
  const store = new FsWechatBotStore(bindingFile);
  const api = new WechatClawbotApi();
  const provisioner = new WechatClawbotProvisioner({ api, store });
  const timeoutMs = Number(arg("--timeout-ms") ?? 8 * 60 * 1000);
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
  // Binding greeting: the program itself sends the intro to the bound account
  // 5s after binding succeeds — no manual step, no waiting for the bound
  // account to message first. Best-effort: a failed greeting is reported but
  // never fails the binding.
  try {
    await api.notifyStart({ baseUrl: bot.baseUrl, token: bot.token });
  } catch {
    // Channel will also be brought up by the inbox hook heartbeat.
  }
  // Wait 5s before sending: a greeting sent 1s after binding (2026-11-10
  // 14:23:52) was accepted by the API but never delivered, while a manual
  // test send later the same day arrived fine. The hook's notify-start for
  // the new bot ran 2s after that greeting, so the channel likely was not
  // up yet. If the delayed greeting still does not arrive, the cause is
  // the missing session, not the channel.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  try {
    await api.sendText({
      baseUrl: bot.baseUrl,
      token: bot.token,
      toUserId: bot.ownerExternalId,
      text: BINDING_GREETING
    });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      botId: bot.id,
      to: bot.ownerExternalId,
      text: BINDING_GREETING
    });
    await appendFile(sentLogFile, entry + "\n", "utf8").catch(() => undefined);
    await chmod(sentLogFile, 0o600).catch(() => undefined);
    emit({ type: "greeting", sent: true, to: bot.ownerExternalId });
  } catch (e) {
    emit({
      type: "greeting",
      sent: false,
      error: e instanceof Error ? e.message : String(e)
    });
  }
  // The binding-time greeting above is best-effort and cannot be verified as
  // delivered: the platform does not deliver a bot's message before the bound
  // account has messaged it first (proven 2026-11-10 — greetings at +1s and
  // +5s after binding, and a test send ~2min after binding, were all accepted
  // by the API but never arrived; only sends after the user messages first
  // arrive). So mark the intro as pending: the worker delivers it on the
  // bound account's first message (intro first, then the reply) and clears
  // this marker. See the hook prompt ("先判断要不要先发介绍").
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
  if (!to) fail("missing --to <userId>");
  if (!text) fail("missing --text <text>");
  const store = new FsWechatBotStore(bindingFile);
  const bot = await selectBot(store);
  const api = new WechatClawbotApi();
  await api.sendText({ baseUrl: bot.baseUrl, token: bot.token, toUserId: to, text });
  // Auto-log every sent message so mirror records never rely on memory.
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    botId: bot.id,
    to,
    text
  });
  await appendFile(sentLogFile, entry + "\n", "utf8").catch(() => undefined);
  await chmod(sentLogFile, 0o600).catch(() => undefined);
  emit({ type: "sent", to, botId: bot.id, botLabel: botLabel(bot) });
}

async function cmdSentLog() {
  const to = arg("--to");
  if (!to) fail("missing --to <userId>");
  const limit = Math.max(1, Number(arg("--limit") ?? 50));
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
    text: string;
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
  for (const e of mine.slice(-limit)) emit({ type: "sent-log", ts: e.ts, to: e.to, text: e.text });
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
  let cursorUpdated = false;
  if (res.get_updates_buf) {
    bot.metadata = { ...(bot.metadata ?? {}), getUpdatesBuf: res.get_updates_buf };
    cursorUpdated = true;
  }
  if (res.ret !== undefined && res.ret !== 0) {
    return {
      ok: false,
      messages: [],
      error: `getupdates ret=${res.ret} errcode=${res.errcode ?? "?"} ${res.errmsg ?? ""}`.trim(),
      bot,
      cursorUpdated
    };
  }
  const messages = (res.msgs ?? [])
    .filter((m) => m.message_type !== 2) // type 2 = bot's own outgoing messages
    .map((m) => {
      const media: PolledMedia[] = [];
      let text = "";
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
        }
      }
      return {
        fromUserId: m.from_user_id ?? "",
        sessionId: m.session_id ?? m.from_user_id ?? "",
        messageId: String(m.message_id ?? m.client_id ?? ""),
        seq: typeof m.seq === "number" ? m.seq : 0,
        text: text.trim(),
        media,
        contextToken: m.context_token ?? ""
      };
    })
    .filter((m) => m.fromUserId && (m.text || m.media.length > 0));
  return { ok: true, messages, bot, cursorUpdated };
}

// Persist one bot's cursor. Must be called SEQUENTIALLY (never concurrently):
// FsWechatBotStore.save is read-modify-write on the shared bindings file.
async function saveCursor(store: FsWechatBotStore, bot: WechatBotBinding): Promise<void> {
  try {
    await store.save(bot);
    await chmod(bindingFile, 0o600).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

async function cmdPoll() {
  const store = new FsWechatBotStore(bindingFile);
  const bot = await selectBot(store);
  const api = new WechatClawbotApi();
  const timeoutMs = Number(arg("--timeout-ms") ?? 35_000);
  const r = await pollBot(api, bot, timeoutMs);
  if (r.cursorUpdated) await saveCursor(store, r.bot);
  if (!r.ok) fail(r.error);
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
  const timeoutMs = Number(arg("--timeout-ms") ?? 15_000);
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
    if (r.cursorUpdated) await saveCursor(store, r.bot);
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

  const res = await fetch(url);
  if (!res.ok) fail(`download failed: ${res.status}`);
  const encBuf = Buffer.from(await res.arrayBuffer());

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
  const plain = Buffer.concat([decipher.update(encBuf), decipher.final()]);
  const { writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, plain);
  emit({ type: "download-media", out, bytes: plain.length });
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === "provision") await cmdProvision();
    else if (cmd === "status") await cmdStatus();
    else if (cmd === "set-label") await cmdSetLabel();
    else if (cmd === "send") await cmdSend();
    else if (cmd === "sent-log") await cmdSentLog();
    else if (cmd === "poll") await cmdPoll();
    else if (cmd === "poll-all") await cmdPollAll();
    else if (cmd === "notify-start") await cmdNotifyStart();
    else if (cmd === "notify-stop") await cmdNotifyStop();
    else if (cmd === "download-media") await cmdDownloadMedia();
    else
      fail(
        `unknown command: ${cmd ?? "(none)"} — use provision|status|set-label|send|sent-log|poll|poll-all|notify-start|notify-stop|download-media`
      );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

void main();
