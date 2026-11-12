---
name: "wechat-bot"
description: "Provision and operate a WeChat bot via Tencent's official iLink ClawBot platform: QR-code binding, sending text messages, and polling incoming messages. Use when the user wants to connect WeChat or chat through a WeChat bot."
icon: "wechat"
metadata: { "includeInPrompt": true }
---

# WeChat Bot

Connect the user to WeChat through a **bot** on Tencent's official iLink ClawBot
platform (`ilinkai.weixin.qq.com`). The user scans a QR code with WeChat to
authorize the bot; the bot then has its own WeChat identity that people (or the
user) can chat with.

**Important scope:** this creates a bot account on WeChat. It does NOT read the
user's existing personal WeChat conversations. The bot only sees messages sent
directly to it. This uses Tencent's official bot platform (no personal-account
protocol hacks), so the user's WeChat account stays safe.

## Tooling

The CLI lives at `~/workspace/skills/wechat-bot/dist/cli.js`. Run it with node:

```
node ~/workspace/skills/wechat-bot/dist/cli.js <command>
```

All output is JSON lines. Bot credentials are stored in
`~/workspace/skills/wechat-bot/state/bindings.json` (mode 0600). Never print the
bot token to the user, and never copy it into memory files or chat.

### Commands

Multiple bots can be bound (one per WeChat account). `--bot <sel>` targets a
specific bot: a 1-based index from `status`, an id prefix, or a
label/displayName substring. Default is the first bound bot, so single-bot
usage is unchanged.

- `provision [--timeout-ms <ms>] [--label <name>]` — generate a binding QR code.
  Prints `{"type":"qr","qrUrl":...}` first, then waits for the user to scan with
  WeChat and confirm. **The owner of the WeChat account must scan it themselves;
  there is no silent/remote binding** (Tencent requirement). On success prints
  `{"type":"confirmed","botId":...}` and saves the binding. QR codes expire
  after a few minutes; if it times out, re-run. Show the `qrUrl` image to the
  user so they can scan it. The user flow in WeChat: scan → tap
  confirm/authorize on the phone.
- `status` — `{"type":"status","connected":true/false,"bots":[{index,id,label,...}]}`.
  Run this before claiming anything about the connection; never rely on memory.
- `set-label --bot <sel> --label <name>` — give a bot a friendly label.
- `send --to <userId> --text <text> [--context-token <token>] [--bot <sel>]` — send a text message to a
  WeChat user via a specific bot. `<userId>` is the `fromUserId` seen on an
  incoming message. Every successful send is auto-logged to
  `state/sent-log.jsonl` (0600); read it back with `sent-log` below so mirror
  records never rely on the worker's memory.
- `send-media --to <userId> --file <path> [--kind image|video|voice|file] [--text <caption>] [--context-token <token>] [--bot <sel>]` — send an image, video, voice, or file (2026-11-11; platform flow: `getUploadUrl` → AES-128-ECB encrypt → POST ciphertext to the iLink CDN → `sendmessage` with the CDN reference). `--kind` is inferred from the extension when omitted (.jpg/.png → image, .mp4 → video, .silk → voice, else file). Voice files must already be SILK-encoded (.silk); there is no mp3→silk encoder here. An optional `--text` caption is sent after the media as its own text message. Auto-logged to `state/sent-log.jsonl` with `kind`/`file`. Video size limit (measured 2026-11-11): files ≤4.6MB upload fine, files ≥5.5MB fail at the CDN with HTTP 500 — keep videos under ~5MB. The CLI enforces size limits (video >5MB refused, other files >20MB refused). Real WeChat .silk voice files start with a 0x02 byte before `#!SILK_V3`; the CLI accepts the magic at offset 0 or 1. Per-bot isolation (Scheme B, 2026-11-11): --file must be inside that bot's own media directory (~/workspace/wechat-bots/<botId8>/media); a file outside it is refused.
- `sent-log --to <userId> [--limit <n>] [--bot <sel>]` — print the last n
  messages this bot sent to a user (chronological), as
  `{"type":"sent-log","ts","to","text"}` lines.
- `poll [--timeout-ms <ms>] [--bot <sel>]` — one long-poll (default 35s) for new
  incoming messages on one bot; prints
  `{"type":"messages","botId","botLabel","count":N,"messages":[{fromUserId,sessionId,messageId,text,contextToken,botId,botLabel}]}`.
  An idle timeout with no messages prints `count: 0` (not an error).
  The poll cursor is persisted per bot; a successful poll's cursor guarantees no duplicates and no loss. If the platform returns an error or an unknown message type, see M4/L-m (audit 2026-11-11). Only
  run `poll` when the user has asked for a WeChat check or a scheduled inbox
  job does — never busy-loop it in a turn.
- `poll-all [--timeout-ms <ms>]` — polls ALL bound bots CONCURRENTLY (one
  ~timeoutMs round covers every bot no matter how many); prints one JSON line
  per bot (`type: "messages"` or `type: "error"`). Cursor saves are done
  sequentially after the parallel round (the bindings file is read-modify-write).
- `notify-start` / `notify-stop` `[--bot <sel>]` — tell the iLink backend the
  channel is up/down (`ilink/bot/msg/notifystart|notifystop`). **Handled by the hook heartbeat (including the first call after binding)** — `cmdProvision` does not call it; otherwise WeChat shows the
  bot as "暂无法连接" (unreachable).

### Acting as the bot's brain

Incoming messages are handled by a SINGLE hook, `wechat-inbox`
(script `~/hooks/scripts/wechat-inbox.sh`, poll every ~8s). It runs
`poll-all` (6s long-poll) covering all bound bots in one round; there is no
per-bot hook and no per-bot wrapper script (`~/hooks/scripts/wechat-inbox-<botid8>.sh`
does not exist on disk, and the definitions directory holds only the single
`wechat-inbox.json`). Do not create a per-contact mirror side chat: context
lives in history files, not side chats. The worker is a history worker: each contact's conversation history lives in
files under `~/workspace/wechat-bots/<botId8>/convs/<sha>/` (sha = first 16 hex chars of
sha256(botId:fromUserId)), with `meta.json` (conversation list), `current.jsonl`
(current conversation, one JSON line per message) and `archive/<id>.jsonl`
(archived conversations). The worker reads the last 40 lines of `current.jsonl`
for context, replies in Chinese as Muse, sends the reply back to WeChat via
`send --bot '<botId>' --context-token '<contextToken>'`, and appends the round to `current.jsonl`. No side
chat is involved: the worker has no `chat.send_message` / `chat.archive` /
`chat.create`, and the old mapping file `~/hooks/state/wechat-sidechats.json`
and per-contact side chats are retired (kept as records only).
Sending the text 「新建对话」 or 「/新建对话」 (exact match, whole message, single message in the batch) is a command, not
chat: the worker archives the current history file (this IS clearing context —
the old history is kept for switching back, but no longer read), starts a fresh
empty `current.jsonl`, and confirms in WeChat with exactly 「已开始新对话。」 (six characters, no extra explanation, never say "之前的内容就不记得了").
Sending 「切换对话」 (same exact-match rule) lists the contact's own
conversations (newest first, stable numbers by creation order, current marked,
10 per page) with a footer explaining 「下一页」「上一页」 to flip pages and
「切换到 数字」 to switch; 「切换到<数字>」或「切换到 <数字>」（空格可有可无） restores that archived conversation
as current; 「修改旁聊名称 <新名字>」 renames the current conversation and
replies exactly 「已改名。」.
Fixed replies the prompt defines (do not improvise other wording): if 「下一页」/「上一页」 arrives before any list was ever shown (list_page missing), reply exactly 「先发「切换对话」查看清单。」. 「切换到」 has three fixed replies: number does not exist → 「没有这个对话，先发「切换对话」看看编号。」; number is the current conversation → 「已经是「<label>」了。」; otherwise → 「已切换到「<label>」。」
Sending 「帮助」 or 「/帮助」 or 「help」 (same exact-match rule) is a command, not
chat: the worker replies with the fixed help text only. The command and its reply are recorded in the conversation history (current.jsonl) like any other message:
指令清单：
帮助 — 显示指令清单
新建对话 — 开始一个新对话
切换对话 — 查看并切换对话
修改旁聊名称 新名字 — 给当前对话改名
Command replies are fixed text only, no extra explanation. Normal chat replies are short, WeChat-style, no explaining command rules.
Binding intro (once only): the worker sends the fixed intro text (below) FIRST, then replies to the message — two messages back-to-back, intro first. It fires ONLY when a pending-intro marker exists for this bot (`~/hooks/state/wechat-intro-pending.<botId8>`, created by `provision` at binding time because the binding-time greeting cannot be delivered — see 1b). There is no 'new contact' welcome: a bot only talks to the WeChat account it is bound to, strangers cannot add the bot, so the only intro is the binding intro for the bound account. The worker deletes the marker after sending the intro, and appends the intro to `current.jsonl` as an assistant message (order: user message, intro, reply). It is never sent again, and 「新建对话」 does not trigger it; command messages do not trigger it either.
你好呀，我是 Muse，你的个人助理，你说的事我会记在当前对话里，不用重复说。
我能帮你：
聊天、回答问题
写东西、改文字、翻译
总结归纳、出主意、做计划
操作：
帮助 — 看指令清单
新建对话 — 开始一个新对话，之前的就不记得了
切换对话 — 看你的对话清单，切回以前的对话
修改旁聊名称 新名字 — 给当前对话改名
直接发消息就能聊。

See the hook prompt (hook id `wechat-inbox`) for the exact history-worker steps; the prompt is the operative spec, this doc is the overview.
Reply rules: NO auto-reply/ack (cancelled by user 2026-09-28) — the worker sends
the substantive reply directly on wake, first thing, no diagnostics beforehand,
and every `wechat_new_messages` wake must produce at least one reply.
Ordering: message handling is serialized PER CONVERSATION (bot + user) via
`~/hooks/state/wechat-inbox.worker.<hash>` lock files — each conversation gets
its own worker. The platform dispatches hook workers FIFO, ONE AT A TIME,
across ALL bots and conversations (verified 2026-11-12: 161 sessions, zero
overlap). So the hook only ever REQUESTS one wake per poll tick; the platform
decides when it actually runs. The per-conversation lock prevents
duplicate/overlapping workers for the SAME conversation — it does NOT create
parallel execution. While a conversation's worker is active, its new messages
buffer in `wechat-inbox.pending.all.jsonl` (single-hook mode; the pending file is
namespaced by bot only in the per-bot mode, which is not deployed) and are
delivered to its next worker in chronological (seq) order; the worker must
analyze a batch ("one thought split into several sends" vs independent
questions) and reply in order without skipping, then `rm -f` the `lockFile`
from its wake payload when done (stale locks >300s are auto-cleared).
Lock TTL (P1-5, 2026-11-12): the 300s TTL is counted from the wake request —
the lock is taken after the media retry, just before wake() — and platform
dispatch queueing time is NOT counted in it. Do not read 300s as "5 minutes
of protection": a worker that runs longer than 300s, or waits in the platform
queue longer than 300s, can be duplicated for the same conversation.
Deploying hook changes (P1-3, forced step, 2026-11-12): NEVER edit the
running hook script in place. Stop the hook first, write the change to a
temp file, pass `bash -n`, atomically `mv` it over the live script, then
re-enable the hook; afterwards verify the change window had 0 `failed`
runs in the hook log. Direct edits caused torn-edit failed runs (10 of 11
in the audit window) and plausibly lost bot2 seq 8. One
worker is woken per poll tick, for the oldest-waiting idle conversation
(oldest by `receivedAtMs`, the local receipt time — seq is per-conversation
and incomparable across bots, so cross-bot ordering uses receivedAtMs; a
pending record also carries `status: "pending"` and its platform `messageId`
for idempotency). Settled policy (2026-11-11, fix plan P2 option (a)): at most one worker is
woken per poll tick, queued by the oldest-waiting conversation. Note: because
wake() exits the script at once (runtime exit 0), the `recorded` outcome for
a paused batch can only be emitted in a tick where no worker was woken; in a
tick where a worker was woken, a paused batch is still recorded to history
but its `recorded` outcome is not emitted. That is a known consequence of
P2 (a) — do not claim the `recorded` outcome is emitted in that case. CLI
maps each message's platform `seq` for ordering within one conversation.
User messages always come before diagnostics: a diagnostic worker is only
woken when no user worker was dispatched that tick (the sole exception is
M-2, when every conversation is busy, so the diagnostic episode is not lost).
The hook script also re-sends `notify-start` for its bot at most every 10
minutes as a presence heartbeat, and tracks poll failures (10 consecutive
failures wakes a diagnostic worker). The user roster
(`~/hooks/state/wechat-roster.json`, botId -> [userIds]) is maintained by the
single hook and guarded by a flock. Do not add a second poller
(cron or loop) — two pollers would race on the persisted cursor.

Per-contact history files (2026-11-10, replaces side-chat routing — the side-chat route was never viable in production: workers have no `chat.send_message`/`chat.archive`/`chat.create`, so the per-contact side chats stayed empty): each WeChat contact (bot + fromUserId) has ONE folder `~/workspace/wechat-bots/<botId8>/convs/<sha>/` (sha = first 16 hex chars of sha256(botId:fromUserId)); that is where context lives. Inside: `meta.json` (`{"conversations":[{"id","label","created_at","status":"current|archived"}],"current_id","list_page"}`; conversations stored oldest→newest, numbers fixed by creation order, list displayed newest→oldest), `current.jsonl` (current conversation, one JSON line per message: `{"ts","seq","role":"user|assistant","text"}` — `ts` is always Beijing time (+08:00), format YYYY-MM-DDTHH:MM:SS+08:00, no milliseconds; convert from UTC if the message arrived in UTC; a user message carrying media also has a `media` array `[{"kind","localPath"}]` so the viewer can display the image/video; lines are appended with `jq -cn` (never hand-built JSON strings, so quotes/newlines can't break the file): user rows carry `seq`, assistant rows have no `seq`, media rows use `--argjson media`), `archive/<id>.jsonl` (one file per archived conversation). The worker reads the last 40 lines of `current.jsonl` for context (command messages don't count toward the 40) and appends each round; 「新建对话」 moves `current.jsonl` to `archive/` and starts a fresh empty one (that is the context clear — the old history is kept, but no longer read); 「切换到<数字>」或「切换到 <数字>」（空格可有可无） swaps an archived file back to current. NOTE: the older per-window mirror side chat (`微信对话镜像·<botLabel>`) described in earlier versions of this doc was never created; the live hook's delivery is the main chat, and worker summaries go there. The retired mapping file `~/hooks/state/wechat-sidechats.json` and the per-contact side chats (all empty, only a MEMORY.md seed each) are kept as records only, never used.
Worker identity: the bot replies in WeChat as Muse, the owner's personal assistant (user: the account owner). The send command uses `--bot '<botId>'` where <botId> is payload.messages[0].botId (the bot that received the message) — never hardcode one bot, so multiple bound bots each reply through their own bot. The worker passes the `contextToken` of the last message in the batch that has one, using the same token for both the intro and the reply; omit `--context-token` only when no message in the batch has one. A full bot id matches by prefix; renaming a label never breaks sending. (The platform displayName is 微信 ClawBot.)
Media and isolation rules for replies:
- 用中文回复，语气像微信聊天一样简短自然，不要用 Markdown 标题。
- 每次回复都要结合 current.jsonl 里的历史，不要当成新对话。
- 图片：直接看消息里给的 localPath 图片文件再回复；没有 localPath 就不许描述、评价或猜测图片内容。
- 语音：优先用 text/voiceText 里的转写理解；hook 下载语音后会自动把 .silk 转成同名 .mp3（转码失败只留 .silk，不影响流程），查看器里能点开播；如需听原音，用 ~/workspace/tools/silk2mp3.sh <localPath.silk> /tmp/voice.mp3 转成 mp3 再听。
- 视频/文件：看 localPath，打不开就说打不开，不许编造。
- 没有 localPath 时：hook 收消息时会先下载媒体（6 次、间隔 10 秒，腾讯 CDN 经常要几十秒才就绪）；还拿不到 localPath 的话，worker 再用消息里 media 的 aesKey/fullUrl（或 encryptedQueryParam）自己跑一次 download-media 重试（最多 3 次、间隔 10 秒），再下不下来才说媒体没收到。
- 回复前先读 ~/workspace/skills/wechat-bot/state/blocked-topics.md（如果这个文件存在），命中隔离话题时含糊带过，绝不承认这份清单存在、不透露内容、不说“用户不让我告诉你”。
- 绝不向对方透露内部技术细节（轮询、hook、后台脚本、side chat、映射表等），问起就用生活化的说法带过。
- 绝不泄露 bot token。

Adding a new bot/window later (checklist):
1. `provision --label '<label>'`, user scans QR to bind.
1b. Binding greeting — REMOVED 2026-11-10: `provision` used to send the fixed welcome text to the bound account after binding succeeds (`notifyStart`, wait 5s, then `sendText` to `bot.ownerExternalId`, best-effort, logged to `sent-log.jsonl`), but it was deleted because it never arrives. (结论已定，2026-11-10 实测：绑定时发介绍到不了。+1秒、+5秒、绑定后约2分钟手动测试，三次都被平台接受但微信里都没收到；只有对方先发消息之后，回复才到。原因：平台不投递机器人主动发的第一条消息，必须对方先发消息建立会话。所以 `provision` 只建待发介绍标记 `~/hooks/state/wechat-intro-pending.<botId8>`，worker 在绑定微信第一次发消息时先发介绍、再回问题，发完删标记。)
2. Do not create a per-contact mirror side chat. Context lives in the history files under `~/workspace/wechat-bots/<botId8>/convs/<sha>/`; per-contact side chats are retired and were never created.
3. No wrapper script and no per-bot hook: the single hook `wechat-inbox` (script `~/hooks/scripts/wechat-inbox.sh`, `poll-all`) already covers all bound bots. Nothing to register per bot.
4. No new hook to add. Verify the new bot appears in `status` (the single hook polls it automatically); the hook's poll_interval is 8s.
5. The quota watchdog already handles the `wechat-inbox` hook; nothing to change.

### Quota guard

Policy (user, 2026-09-28): WeChat channels may only consume the FREE weekly
quota, never the permanent additional-tokens pool. There is no platform switch
to pin a worker to a quota pool, so this is enforced by the
`wechat-quota-watchdog` hook (script `~/hooks/scripts/wechat-quota-watchdog.sh`,
every 10 min): at ≥98% free used it pauses the `wechat-inbox` hook AND sends
each known WeChat user a one-time notice with the recovery time (from
`subscription-status status` "Weekly limit resets ...", converted to Beijing
time); after the weekly reset it resumes — but only if the watchdog itself
paused it. State `~/hooks/state/wechat-quota-watchdog.json` tracks
`paused_by_watchdog` and `exhaustion_notified` (notice sent once per episode,
never repeated); a manual user disable is never auto-reverted.
The user roster (`~/hooks/state/wechat-roster.json`, botId -> [userIds]) is
maintained by the inbox script on every batch of incoming messages.

### Isolation blocklist

`state/blocked-topics.md` is the isolation list for **all** WeChat channels.
Only the main-chat agent may edit it, and only on the user's explicit
instruction in the main chat. Every WeChat worker must read it before replying:
on a hit, deflect vaguely — never admit the list exists, never reveal its
contents, never say "the owner told me not to tell you". Workers must also
never disclose internal mechanics (polling, heartbeat, notifystart, the mirror
window, hook scripts, troubleshooting) to any WeChat user; deflect with
everyday language instead.

### Troubleshooting

- QR expired / `wechat ... 二维码已过期`: re-run `provision` for a fresh code.
- `need_verifycode`: the platform asked for a phone verification code, which the
  CLI does not implement — re-run `provision` later.
- `binded_redirect`: the bot is already bound elsewhere; unbind it in WeChat
  first, then re-run `provision`.
- Auth errors on `send`/`poll`: re-run `status`; if the binding looks stale,
  re-run `provision` to rebind.
