#!/usr/bin/env bash
# WeChat inbox watcher — ONE hook for all bots (single hook + poll-all).
#
# Bot selection comes from the WECHAT_BOT_SEL environment variable, set by the
# per-window wrapper script (wechat-inbox-<sel>.sh). When set: single-bot mode
# (poll --bot <sel> only, state files namespaced by <sel>). When unset: legacy
# all-bots mode (poll-all).
# The deployed mode is the single hook (id `wechat-inbox`) in all-bots mode:
# one hook polls all bound bots with poll-all every ~8s. Per-bot hooks and
# per-bot wrapper scripts (wechat-inbox-<sel>.sh) do not exist; the
# WECHAT_BOT_SEL single-bot path is retained code only, not the deployed
# architecture. There is no per-contact mirror side chat: context lives in
# history files under ~/workspace/wechat-bots/<botId8>/convs/<sha>/.
#
# Ordering: each CONVERSATION (bot + user) is handled by at most ONE worker at
# a time (per-conversation lock file). The platform dispatches hook workers
# FIFO, ONE AT A TIME, across ALL bots and conversations (verified
# 2026-11-12: 161 sessions, zero overlap; a bot1 reply waited ~3.3 min behind
# other chats' subagents). So the hook only ever REQUESTS one wake per poll
# tick; the platform decides when it actually runs. The per-conversation
# lock prevents duplicate/overlapping workers for the SAME conversation and
# keeps its replies in order — it does NOT create parallel execution.
# Messages inside one conversation are always delivered in chronological
# (seq) order, so a single conversation's replies can never overtake each
# other. Across conversations, pending tasks are ordered by receivedAtMs
# (see wake_idle_for_pending), because seq is per-conversation and
# incomparable across bots (V3 Task D).
# NOTE: no auto-reply/ack — the user cancelled it. The worker sends the
# substantive reply directly; expect worker cold-start latency (~tens of secs).
#
# DEPLOY (P1-3, forced 2026-11-12): NEVER edit this running script in place.
# Stop the hook first (hooks.disable wechat-inbox), write a temp copy, pass
# `bash -n`, atomically `mv` it over this file, then re-enable the hook.
# Direct edits caused torn-edit failed runs (10 of 11 failed runs in the
# audit window) and plausibly lost bot2 seq 8 (2026-11-12 02:42-02:43).
#
# Media auto-download (2026-09-30; two-pass since 2026-11-10): messages
# carrying media (image/voice/video/file) get each attachment downloaded via
# `download-media` and the local path written back as .media[].localPath, so
# the worker can actually see the image / hear the voice instead of
# guessing. Two passes, buffer first: the intake pass (short patience) runs
# right after messages are buffered; the wake pass retries anything still
# missing with full patience before a worker is woken.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

DRY="${HATCH_HOOK_DRY_RUN:-0}"
SKILL_DIR="${WECHAT_BOT_SKILL_DIR:-$HOME/workspace/skills/wechat-bot}"
CLI="node $SKILL_DIR/dist/cli.js"
STATE_DIR="$HOME/hooks/state"
LOCK_FILE="$STATE_DIR/wechat-inbox.lock"
NOTIFY_PREFIX="$STATE_DIR/wechat-inbox.notifystart"
FAIL_PREFIX="$STATE_DIR/wechat-inbox.failcount"
DIAG_PREFIX="$STATE_DIR/wechat-inbox.diag-notified"
LEGACY_WORKER_LOCK="$STATE_DIR/wechat-inbox.worker"   # pre-2026-09-28 global lock (transition only)
WORKER_LOCK_PREFIX="$STATE_DIR/wechat-inbox.worker."
ROSTER_FILE="$STATE_DIR/wechat-roster.json"
ROSTER_LOCK="$STATE_DIR/wechat-roster.lock"
WORKER_TTL=300
SEP=$'\x01'
MEDIA_DATE="$(date +%F)"
# Per-bot isolation (Scheme B): every bot has its own root under
# ~/workspace/wechat-bots/<botId8>/ . Media lands in that bot's own
# media/<date>/ — never in a shared directory — so one bot's attachments
# can never be seen or sent by another bot.
BOTS_ROOT="$HOME/workspace/wechat-bots"
# Media directory for the bot whose id starts with $1 (8-char prefix).
bot_media_dir() {
  printf '%s/%s/media/%s' "$BOTS_ROOT" "$1" "$MEDIA_DATE"
}
# Media download retries: Tencent's CDN often takes tens of seconds to have a
# just-notified file ready, so a short retry window loses media that would
# have downloaded fine moments later (upstream observed 3x5s insufficient).
# 6 attempts x 10s is the full-patience window (user chose this 2026-11-10),
# used by the wake pass; the intake pass uses a short window
# (MEDIA_INTAKE_RETRIES) so slow files cannot hold up buffering and waking.
MEDIA_RETRIES=6
MEDIA_RETRY_SLEEP=10
MEDIA_INTAKE_RETRIES=3
# P1-9/P1-10: total time budget (seconds) for one media file in try_download.
# Exceeding it abandons this round; the message is still woken with the
# media missing (worker retries itself), never stuck in pending.
MEDIA_TOTAL_BUDGET_SECS=100

BOT_SEL="${WECHAT_BOT_SEL:-}"
NS="${BOT_SEL:-all}"
PENDING_FILE="$STATE_DIR/wechat-inbox.pending.$NS.jsonl"

mkdir -p "$STATE_DIR"

# Single instance: skip if a previous poll is still running.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  silent "previous poll still running"
  exit 0
fi

# Emit a "recorded" result (a paused batch was recorded to history, no
# worker woken). The hook runtime has no public "recorded" emitter, so call
# its generic emit directly; it accepts any decision string. Exits 0 like
# wake/silent — i.e. calling this ENDS the script, so code after it in the
# caller never runs (see P1-7 in wake_idle_for_pending).
recorded() {
  _hatch_hook_emit "recorded" "${1-}" "${2-}"
}

# Conversation key -> lock file name (hash keeps it filename-safe).
key_hash() {
  printf '%s' "$1" | sha256sum | cut -c1-16
}

# True (0) if the given worker lock is currently active.
# Cleans up a stale lock (worker crashed or runtime never launched it).
lock_busy() {
  local lf="$1"
  [ -f "$lf" ] || return 1
  local started now
  started="$(cat "$lf" 2>/dev/null || echo 0)"
  case "$started" in ''|*[!0-9]*) started=0 ;; esac
  now="$(date +%s)"
  if [ $((now - started)) -ge "$WORKER_TTL" ]; then
    rm -f "$lf"
    log "wechat worker lock stale, cleared: $lf"
    return 1
  fi
  return 0
}

# Sweep stale per-conversation locks (side-effect cleanup).
for _lf in "$WORKER_LOCK_PREFIX"*; do
  [ -e "$_lf" ] || continue
  lock_busy "$_lf" || true
done

pending_count() {
  if [ -s "$PENDING_FILE" ]; then
    jq -s 'length' "$PENDING_FILE" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

SILK_DECODER="${WECHAT_SILK_DECODER:-$HOME/workspace/tools/silk-v3-decoder/silk/decoder}"

# WeChat voice (.silk) cannot play in a browser; transcode a sibling .mp3
# next to it so the conversation viewer can offer a playable voice bar.
# Best effort only: any failure leaves the .silk as-is and changes nothing.
transcode_voice() {
  local silk="$1" mp3="${1%.silk}.mp3" pcm
  [ -s "$mp3" ] && return 0
  [ -x "$SILK_DECODER" ] || return 1
  command -v ffmpeg >/dev/null 2>&1 || return 1
  pcm="$(mktemp)"
  if "$SILK_DECODER" "$silk" "$pcm" >/dev/null 2>&1 && [ -s "$pcm" ]; then
    if ffmpeg -y -v error -f s16le -ar 24000 -ac 1 -i "$pcm" -codec:a libmp3lame -q:a 4 -f mp3 "$mp3.tmp" >/dev/null 2>&1 && [ -s "$mp3.tmp" ]; then
      mv "$mp3.tmp" "$mp3"
      rm -f "$pcm"
      log "wechat: voice transcoded $mp3"
      return 0
    fi
  fi
  rm -f "$pcm" "$mp3.tmp"
  return 1
}

# File name for a media attachment (our naming: kind-messageId-index.ext;
# file attachments keep their original extension when it is short).
# $1 is the receiving bot's 8-char id prefix; the file lands in that bot's
# own media directory (per-bot isolation).
media_out_path() {
  local bot8="$1" kind="$2" mid="$3" idx="$4" fname="$5" ext fext
  case "$kind" in
    image) ext="jpg" ;;
    voice) ext="silk" ;;
    video) ext="mp4" ;;
    file) ext="dat" ;;
    *) ext="bin" ;;
  esac
  if [ "$kind" = "file" ] && [ -n "$fname" ] && [[ "$fname" == *.* ]]; then
    fext="${fname##*.}"
    if [ "${#fext}" -le 8 ]; then ext="$fext"; fi
  fi
  printf '%s/%s-%s-%s.%s' "$(bot_media_dir "$bot8")" "$kind" "$mid" "$idx" "$ext"
}

# Download one media file with retries. The file lands under a temp name
# first and is renamed only on success, so a half-written file can never
# pose as a completed download. An already-present final file counts as
# done (deterministic names make re-runs idempotent).
try_download() {
  local aes="$1" furl="$2" eparam="$3" out="$4" attempts="$5"
  if [ -s "$out" ]; then
    case "$out" in *.silk) transcode_voice "$out" || true ;; esac
    return 0
  fi
  local tmp="${out}.part" attempt _dl_start _dl_now
  _dl_start="$(date +%s)"
  rm -f "$tmp"
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    # P1-9/P1-10: total budget per file. Give up this round once exceeded;
    # the caller still wakes the worker (media-missing, worker fallback).
    _dl_now="$(date +%s)"
    if [ $(( _dl_now - _dl_start )) -ge "$MEDIA_TOTAL_BUDGET_SECS" ]; then
      log "wechat: media download total-timeout out=$out elapsed=$(( _dl_now - _dl_start ))s"
      rm -f "$tmp"
      return 1
    fi
    if [ -n "$furl" ]; then
      timeout 95 $CLI download-media --aes-key "$aes" --full-url "$furl" --out "$tmp" >/dev/null 2>&1 || true
    elif [ -n "$eparam" ]; then
      timeout 95 $CLI download-media --aes-key "$aes" --enc-param "$eparam" --out "$tmp" >/dev/null 2>&1 || true
    else
      rm -f "$tmp"
      return 1
    fi
    if [ -s "$tmp" ]; then
      mv "$tmp" "$out"
      case "$out" in *.silk) transcode_voice "$out" || true ;; esac
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then sleep "$MEDIA_RETRY_SLEEP"; fi
  done
  rm -f "$tmp"
  return 1
}

# Try to download the media attachments of the messages in $1 (one JSON per
# line) with $2 attempts each. For every success, append a
# "messageId_index<TAB>localPath" line to $3. Entries that already carry
# .localPath, or have no download credentials, are skipped.
# Message media schema (from CLI poll): .media[] = {kind, aesKey, fullUrl,
# encryptedQueryParam, voiceText, fileName}.
download_media_attempts() {
  local src="$1" attempts="$2" okfile="$3" mid bot bot8
  jq -c 'select(.media) | {messageId, botId, media}' "$src" 2>/dev/null | while read -r line; do
    mid="$(echo "$line" | jq -r '.messageId')"
    bot="$(echo "$line" | jq -r '.botId // empty')"
    # Isolation: media lands in the receiving bot's own directory. A
    # message without a botId cannot be attributed, so skip it rather
    # than writing to any shared location.
    if [ -z "$bot" ]; then
      log "wechat: media skipped, no botId mid=$mid"
      continue
    fi
    bot8="${bot:0:8}"
    mkdir -p "$(bot_media_dir "$bot8")" 2>/dev/null || true
    echo "$line" | jq -c '.media | to_entries[] | select(.value.localPath == null) | {idx: .key, m: .value}' | while read -r e; do
      local idx kind aes furl eparam fname out
      idx="$(echo "$e" | jq -r '.idx')"
      kind="$(echo "$e" | jq -r '.m.kind')"
      aes="$(echo "$e" | jq -r '.m.aesKey // empty')"
      furl="$(echo "$e" | jq -r '.m.fullUrl // empty')"
      eparam="$(echo "$e" | jq -r '.m.encryptedQueryParam // empty')"
      fname="$(echo "$e" | jq -r '.m.fileName // empty')"
      [ -n "$aes" ] || continue
      # Skip when there is nothing downloadable.
      if [ -z "$furl" ] && [ -z "$eparam" ]; then
        continue
      fi
      out="$(media_out_path "$bot8" "$kind" "$mid" "$idx" "$fname")"
      if try_download "$aes" "$furl" "$eparam" "$out" "$attempts"; then
        log "wechat: media downloaded $out"
        printf '%s\t%s\n' "${mid}_${idx}" "$out" >> "$okfile"
      else
        log "wechat: media download deferred mid=$mid idx=$idx kind=$kind"
      fi
    done
  done
  return 0
}

# Rewrite the JSONL file $1 in place: fill in .media[i].localPath from the
# "messageId_index<TAB>localPath" lines in $2. Records not listed, and
# entries that already carry a localPath, pass through unchanged.
apply_media_ok() {
  local src="$1" okfile="$2" tmp_p
  tmp_p="$(mktemp)"
  if jq -s -c --slurpfile ok <(jq -R -s 'split("\n")|map(select(length>0))' "$okfile") '
    ($ok[0] | map(split("\t") | {(.[0]): .[1]}) | add // {}) as $okmap |
    .[] | .messageId as $mid |
    if .media then
      .media = (.media | to_entries | map(
        .key as $i | .value as $m |
        if (($okmap["\($mid)_\($i)"] // null) and ($m.localPath == null))
        then $m + { localPath: $okmap["\($mid)_\($i)"] }
        else $m
        end
      ))
    else .
    end
  ' "$src" > "$tmp_p" 2>/dev/null; then
    mv "$tmp_p" "$src"
    return 0
  else
    rm -f "$tmp_p"
    return 1
  fi
}

# Atomic pending write (P1-8, 2026-11-12): never truncate PENDING_FILE in
# place (printf > file). Write a temp file and mv it over, so a kill between
# truncate and write cannot corrupt the whole queue.
pending_write() {
  local content="$1" tmp
  tmp="$(mktemp)" || return 1
  printf '%s\n' "$content" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$PENDING_FILE" || { rm -f "$tmp"; return 1; }
  return 0
}

# Intake media pass: the messages are already in the pending buffer (buffer
# first, nothing can be lost from here on). Try to fetch this run's new media
# right away with short patience; successes get their localPath written back
# into the buffered records. A failure is NOT final: the wake pass retries
# with full patience, and the worker has its own fallback after that.
intake_download() {
  local src="$1" ok_list
  ok_list="$(mktemp)"
  download_media_attempts "$src" "$MEDIA_INTAKE_RETRIES" "$ok_list"
  if [ -s "$ok_list" ] && [ -f "$PENDING_FILE" ]; then
    apply_media_ok "$PENDING_FILE" "$ok_list" || log "wechat: media write-back failed (intake)"
  fi
  rm -f "$ok_list"
}

# Retry media for the messages about to be woken (a JSON array in $1):
# files the intake pass deferred get full patience here, so the worker
# usually receives media with localPath already attached instead of having
# to fall back to downloading itself. Returns the enriched array on stdout.
retry_media_for_wake() {
  local msgs="$1" msgs_file ok_list enriched
  msgs_file="$(mktemp)"
  ok_list="$(mktemp)"
  if ! echo "$msgs" | jq -c '.[]' 2>/dev/null > "$msgs_file"; then
    rm -f "$msgs_file" "$ok_list"
    printf '%s' "$msgs"
    return 0
  fi
  download_media_attempts "$msgs_file" "$MEDIA_RETRIES" "$ok_list"
  if [ -s "$ok_list" ]; then
    apply_media_ok "$msgs_file" "$ok_list" || true
    enriched="$(jq -s -c '.' "$msgs_file" 2>/dev/null)" || enriched=""
    [ -n "$enriched" ] && printf '%s' "$enriched" || printf '%s' "$msgs"
  else
    printf '%s' "$msgs"
  fi
  rm -f "$msgs_file" "$ok_list"
  return 0
}

# Ensure a conversation directory exists with the worker's initial layout
# (meta.json with one conversation "对话 1", empty current.jsonl). Does NOT
# touch an existing meta.json (it holds the real conversation list).
# $1: CONV_DIR path. Returns 0 on success, 1 on failure.
ensure_conv_dir() {
  local dir="$1" id created
  mkdir -p "$dir/archive" || return 1
  if [ ! -f "$dir/meta.json" ]; then
    id="$(TZ=Asia/Shanghai date '+%Y%m%d-%H%M%S')"
    created="$(TZ=Asia/Shanghai date '+%Y-%m-%dT%H:%M:%S+08:00')"
    if ! jq -cn --arg id "$id" --arg created "$created" \
      '{conversations:[{id:$id,label:"对话 1",created_at:$created,status:"current"}],current_id:$id,list_page:1}' \
      > "$dir/meta.json.tmp"; then
      rm -f "$dir/meta.json.tmp"
      return 1
    fi
    mv "$dir/meta.json.tmp" "$dir/meta.json" || return 1
  fi
  [ -f "$dir/current.jsonl" ] || touch "$dir/current.jsonl" || return 1
  return 0
}

# Fast-path history record (2026-11-11): append the incoming user message
# lines for one batch (a JSON array in $1) to the conversation's
# current.jsonl. The batch is one conversation's messages (same botId and
# fromUserId), already sorted by seq; media localPath is already attached
# (intake pass + wake pass). The worker (if woken) appends ONLY its reply
# line(s) afterwards; it does not re-append user lines (see prompt), with
# a seq check as a fallback if this append ever fails.
# $1: JSON array of messages. $2: botId8. $3: contactSha.
# Returns 0 if every line was appended, 1 otherwise (caller still wakes
# the worker; the worker's seq check covers the missing user line).
fastpath_record() {
  local msgs="$1" bot8="$2" sha="$3"
  local conv_dir ts lines
  conv_dir="$BOTS_ROOT/$bot8/convs/$sha"
  if ! ensure_conv_dir "$conv_dir"; then
    return 1
  fi
  ts="$(TZ=Asia/Shanghai date '+%Y-%m-%dT%H:%M:%S+08:00')"
  lines="$(printf '%s' "$msgs" | jq -c --arg ts "$ts" '
    .[] | {
      ts: $ts,
      seq: (.seq // 0),
      role: "user",
      text: (.text // "")
    } + (if ((.media // []) | map(select(.localPath != null)) | length) > 0 then
      {media: (.media | map(select(.localPath != null) | {kind, localPath}))}
    else {} end)
  ' 2>/dev/null)" || return 1
  [ -n "$lines" ] || return 0
  printf '%s\n' "$lines" >> "$conv_dir/current.jsonl" || return 1
  return 0
}

# Wake at most ONE worker per poll tick, for the oldest-waiting conversation
# whose lock is free (settled policy 2026-11-11, fix plan P2 option (a):
# one worker per tick, queued by oldest wait). The loop below still scans all
# waiting conversations, but wake() exits the script at once (runtime exit 0),
# so only the first wake in a tick ever runs; later iterations are unreachable
# in production. Extracts that conversation's messages (chronological by seq)
# from the pending buffer, takes its lock, and wakes.
# NOTE: for the same reason, the `recorded` outcome for paused batches can
# only be emitted in a tick where no worker was woken (see the end of this
# function); a paused batch recorded in a tick where a worker was woken is
# still in history, but its `recorded` outcome is never emitted. Known
# consequence of P2 (a); do not claim otherwise.
# Priority (V3 Task F, formalized 2026-11-12): user messages ALWAYS come
# before diagnostics. This function only ever wakes a user-reply worker.
# A diagnostic (wechat_poll_failing) is emitted ONLY by the caller, and only
# when this function returned 1 (no user worker was dispatched this tick).
# If a user worker was dispatched, the failing-bot info rides along in its
# payload (failingBot) and the worker does the diagnostic AFTER replying.
# The sole exception is M-2: when every conversation is busy, the diagnostic
# still goes out so the episode is not lost (the dedup marker would block
# every later report of the same episode).
wake_idle_for_pending() {
  local failing="$1"
  [ -s "$PENDING_FILE" ] || return 1
  local keys k h lf msgs rest rest_rc payload woke polledAtMs
  local conv_bot conv_from bot8 sha recorded_msgs nmsgs
  # P1-8: if pending is corrupt, quarantine it (never silently overwrite or
  # append) and stop this tick; the backup preserves the records for manual
  # recovery.
  if ! jq -s -e . "$PENDING_FILE" >/dev/null 2>&1; then
    mv "$PENDING_FILE" "$PENDING_FILE.corrupt-$(date +%s)" 2>/dev/null || true
    log "wechat: pending corrupt, quarantined (see .corrupt-* backup)"
    return 1
  fi
  # Order waiting conversations by their OLDEST receivedAtMs (V3 Task D,
  # 2026-11-12): seq is per-conversation and incomparable across bots, so
  # cross-bot ordering must use the local receipt time. Records that predate
  # receivedAtMs (no field) count as 0, i.e. oldest, so they are never lost
  # behind newer records. Within a conversation, messages stay in seq order
  # (see the msgs extraction below).
  # Status filter (V3 Task E): only records with status "pending" (or
  # legacy records with no status field) are eligible to be woken. A record
  # leaves pending when it is handed to the platform (H-1 removal just
  # before wake()); that removal IS the transition to "dispatched", and the
  # dispatch is recorded in the structured log (see below). Filtering here
  # guarantees a dispatched record can never be re-woken by a later tick.
  keys="$(jq -s -r --arg sep "$SEP" '
    [ .[] | select(.status == "pending" or .status == null)
      | {k: (.botId + $sep + .fromUserId), r: (.receivedAtMs // 0)} ]
    | sort_by(.k)
    | group_by(.k)
    | map({k: .[0].k, oldest: (map(.r) | min)})
    | sort_by(.oldest, .k) | .[].k
  ' "$PENDING_FILE" 2>/dev/null)"
  [ -n "$keys" ] || return 1
  woke=""
  recorded_msgs=0
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    h="$(key_hash "$k")"
    lf="$WORKER_LOCK_PREFIX$h"
    if lock_busy "$lf"; then
      continue
    fi
    # P1-5 (light, 2026-11-12): the lock is NOT taken here any more. It is
    # taken after the media retry + fast-path record, immediately before
    # wake(), so the 300s TTL starts at the wake request (see below).
    msgs="$(jq -s -c --arg k "$k" --arg sep "$SEP" '
      [ .[] | select((.botId + $sep + .fromUserId) == $k)
        | select(.status == "pending" or .status == null) ] | sort_by(.seq, .messageId)
    ' "$PENDING_FILE" 2>/dev/null)"
    if [ -z "$msgs" ] || [ "$msgs" = "[]" ]; then
      rm -f "$lf"
      continue
    fi
    # H-1 (2026-11-12): compute the remaining buffer now, but do NOT remove
    # this conversation from pending yet. Removal happens only after the
    # slow media retry below, immediately before wake() — so if the hook
    # is killed by the 120s timeout during media retry, the messages are
    # still in pending and the next tick will re-wake them.
    # P1-16: distinguish jq failure (keep the file, skip this conversation)
    # from a legitimately empty rest (this was the only conversation).
    rest=""
    rest_rc=0
    rest="$(jq -s -c --arg k "$k" --arg sep "$SEP" '
      .[] | select((.botId + $sep + .fromUserId) != $k)
    ' "$PENDING_FILE" 2>/dev/null)" || rest_rc=$?
    if [ "$rest_rc" -ne 0 ]; then
      log "wechat: pending rest compute failed, keeping pending file"
      rm -f "$lf"
      continue
    fi
    # Fast path (2026-11-11): record the incoming user lines now, in the
    # hook, so they appear in the viewer in ~16s instead of waiting ~2.5
    # min for a worker to wake up. The worker (if woken) appends ONLY its
    # reply line(s) afterwards; it does not re-append user lines (the
    # prompt has a seq check as a fallback if this append ever fails).
    # Media ordering (2026-11-12, V2 merge): paused batches are recorded
    # immediately WITHOUT any media download, so they never pay the
    # up-to-6x10s wait; non-paused batches retry media FIRST, then record,
    # so the history line carries the final localPath. H-1 still holds:
    # pending removal stays AFTER the media retry, immediately before
    # wake() (paused batches that fall through below had no media retry;
    # their removal still happens here, immediately before wake()).
    conv_bot="${k%%$SEP*}"
    conv_from="${k#*$SEP}"
    bot8="${conv_bot:0:8}"
    sha="$(printf '%s' "$conv_bot:$conv_from" | sha256sum | cut -c1-16)"
    # Pause check (L18, 2026-11-11): checked FIRST, so a paused batch
    # never pays the up-to-6x10s download wait. Skip waking ONLY if the
    # messages were actually recorded above. If the fast-path record
    # failed, wake the worker anyway WITHOUT a media retry: its seq check
    # re-appends the missing user line(s) and the pause section records
    # them with no reply. Otherwise a failed append + pause would silently
    # lose the batch.
    if [ -f "$STATE_DIR/wechat-paused.$bot8.$sha" ]; then
      record_ok=0
      if fastpath_record "$msgs" "$bot8" "$sha"; then
        record_ok=1
      else
        log "wechat: paused fast-path record failed (conv $bot8.$sha), worker will cover via seq check"
      fi
      if [ "$record_ok" = 1 ]; then
        nmsgs="$(printf '%s' "$msgs" | jq 'length' 2>/dev/null || echo 0)"
        case "$nmsgs" in ''|*[!0-9]*) nmsgs=0 ;; esac
        # Paused batches are already recorded to history and need no worker:
        # remove them from pending here (they never reach wake() below).
        # P1-8: atomic write; on failure the file is untouched, so the batch
        # stays pending instead of being lost.
        if [ -n "$rest" ]; then
          if ! pending_write "$rest"; then
            log "wechat: pending atomic write failed (paused conv $bot8.$sha), keeping pending file"
            rm -f "$lf"
            continue
          fi
        else
          rm -f "$PENDING_FILE"
        fi
        recorded_msgs=$((recorded_msgs + nmsgs))
        rm -f "$lf"
        continue
      fi
      # Record failed: fall through to wake() below with no media retry.
    else
      # Media retry before recording (only for non-paused batches): files
      # the intake pass deferred get full patience here, so the worker
      # usually receives media with localPath already attached instead of
      # having to fall back to downloading itself — and fastpath_record
      # then writes the final localPath into the history line.
      msgs="$(retry_media_for_wake "$msgs")"
      record_ok=0
      if fastpath_record "$msgs" "$bot8" "$sha"; then
        record_ok=1
      else
        log "wechat: fast-path record failed (conv $bot8.$sha), worker will cover via seq check"
      fi
    fi
    # P1-4 (2026-11-12): payload assembly and the dispatch log are built
    # BEFORE the pending removal below. The old comment claimed "a kill
    # after this point cannot lose the batch" — that was wrong: the old code
    # still ran payload jq + dispatch log between removal and wake(). Now
    # the only thing between removal and wake() is wake() itself, so the
    # residual window is just that one call. If payload construction fails
    # here, pending is untouched and the lock is released; the next tick
    # retries.
    polledAtMs="$(date +%s%3N)"
    if [ -n "$failing" ]; then
      payload="$(jq -n --argjson msgs "$msgs" --arg lf "$lf" --argjson fb "$failing" --argjson polledAtMs "$polledAtMs" \
        '{type:"messages", count: ($msgs|length), messages: $msgs, lockFile: $lf, failingBot: $fb, polledAtMs: $polledAtMs}')" || { rm -f "$lf"; log "wechat: dispatch payload build failed (conv $bot8.$sha), keeping pending"; return 1; }
    else
      payload="$(jq -n --argjson msgs "$msgs" --arg lf "$lf" --argjson polledAtMs "$polledAtMs" \
        '{type:"messages", count: ($msgs|length), messages: $msgs, lockFile: $lf, polledAtMs: $polledAtMs}')" || { rm -f "$lf"; log "wechat: dispatch payload build failed (conv $bot8.$sha), keeping pending"; return 1; }
    fi
    # Structured dispatch log (V3 §九, Fix 5): what is about to be handed to
    # the platform, when, and what remains queued. This record, together
    # with the H-1 removal below, IS the "dispatched" transition. Note the
    # hook cannot see whether the worker later runs or finishes; do not
    # read a dispatch log as a completion log.
    _d_count="$(printf '%s' "$msgs" | jq 'length' 2>/dev/null || echo 0)"
    case "$_d_count" in ''|*[!0-9]*) _d_count=0 ;; esac
    _d_ids="$(printf '%s' "$msgs" | jq -r 'map(.messageId) | join(",")' 2>/dev/null || echo "?")"
    _d_remain="$(pending_count)"
    log "wechat: dispatch conv=$bot8.$sha count=$_d_count messageIds=${_d_ids:-?} polledAtMs=$polledAtMs status=dispatched queue_remaining=$_d_remain" || true
    # P1-5 (light): take the lock only now, after the media retry and
    # fast-path record, immediately before wake(). The 300s TTL therefore
    # starts at the wake request; platform dispatch queueing time is NOT
    # counted in the TTL, and 300s must not be read as "5 minutes of
    # protection" — see SKILL.md.
    date +%s > "$lf" || { log "wechat: lock write failed conv=$bot8.$sha"; return 1; }
    # H-1: remove this conversation from pending only now — media retry is
    # done, payload is built, and wake() is next. This removal IS the
    # "dispatched" transition (V3 Task E): the records leave pending
    # because they have been handed to the platform. Limitation, stated
    # plainly: the hook cannot tell whether the woken worker later runs,
    # succeeds, or fails, so it cannot automatically return a failed
    # message to pending. Recovery for a silently failed worker is the
    # lock TTL (300s) plus the user's next message, which wakes a worker
    # that sees the unreplied message in history.
    if [ -n "$rest" ]; then
      if ! pending_write "$rest"; then
        log "wechat: pending atomic write failed (conv $bot8.$sha), keeping pending file"
        rm -f "$lf"
        return 1
      fi
    else
      rm -f "$PENDING_FILE"
    fi
    wake "wechat_new_messages" "$payload"
    woke=1
  done <<< "$keys"
  # Paused batches were recorded above and no worker was woken for them.
  # Report distinctly so the run is distinguishable from "wake"/"silent".
  # (In production a wake() call exits the script, so reaching here with
  # recorded_msgs > 0 means no worker was woken at all.)
  # P1-7: recorded() ends the script (runtime emit exits 0), so emitting it
  # here would make the caller's M-2 diagnostic branch unreachable. When a
  # failing bot is waiting, return 1 instead so the caller can dispatch the
  # diagnostic; the paused batch is already in history, only its `recorded`
  # outcome is not emitted in that tick.
  if [ "$recorded_msgs" -gt 0 ] && [ -z "$woke" ]; then
    if [ -n "$failing" ]; then
      return 1
    fi
    recorded "paused: $recorded_msgs message(s) recorded, no worker woken"
  fi
  [ -n "$woke" ] && return 0
  return 1
}

# Bot list as "<id>\t<label>" lines (filtered to our bot in single-bot mode).
if [ -n "$BOT_SEL" ]; then
  BOTS="$(timeout 15 $CLI status 2>/dev/null | jq -r --arg sel "$BOT_SEL" \
    '.bots[]? | select(.id | startswith($sel)) | "\(.id)\t\(.label)"')" || BOTS=""
else
  BOTS="$(timeout 15 $CLI status 2>/dev/null | jq -r '.bots[]? | "\(.id)\t\(.label)"')" || BOTS=""
fi
if [ -z "$BOTS" ]; then
  log "wechat: no bots bound"
  silent "no bots"
  exit 0
fi

# Presence heartbeat per bot, at most every 10 min.
if [ "$DRY" != "1" ]; then
  now="$(date +%s)"
  while IFS=$'\t' read -r bid blabel; do
    [ -n "$bid" ] || continue
    short="${bid:0:8}"
    nf="$NOTIFY_PREFIX.$short"
    last="0"
    [ -f "$nf" ] && last="$(cat "$nf" 2>/dev/null || echo 0)"
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    if [ $((now - last)) -ge 600 ]; then
      if timeout 15 $CLI notify-start --bot "$bid" >/dev/null 2>&1; then
        echo "$now" > "$nf"
      else
        log "wechat notify-start failed for [$blabel]"
      fi
    fi
  done <<< "$BOTS"
fi

# Poll: single bot in single-bot mode, all bots in legacy mode.
if [ -n "$BOT_SEL" ]; then
  POLL_OUT="$($CLI poll --bot "$BOT_SEL" --timeout-ms 6000 2>/dev/null)" || {
    log "wechat poll crashed"
    silent "poll crashed"
    exit 0
  }
else
  POLL_OUT="$($CLI poll-all --timeout-ms 6000 2>/dev/null)" || {
    log "wechat poll-all crashed"
    silent "poll-all crashed"
    exit 0
  }
fi

MESSAGES_FILE="$(mktemp)" || MESSAGES_FILE="$STATE_DIR/wechat-inbox.messages.tmp"
: > "$MESSAGES_FILE" || { log "wechat: messages temp file unavailable"; silent "temp file unavailable"; exit 0; }
FAILING_BOT=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  # P1-2: every jq assignment in this loop has a fallback, so one bad line
  # cannot kill the whole tick (set -e) after the cursor has advanced.
  t="$(echo "$line" | jq -r '.type // ""' 2>/dev/null)" || t=""
  bid="$(echo "$line" | jq -r '.botId // ""' 2>/dev/null)" || bid=""
  blabel="$(echo "$line" | jq -r '.botLabel // ""' 2>/dev/null)" || blabel=""
  short="${bid:0:8}"
  [ -n "$short" ] || continue
  ff="$FAIL_PREFIX.$short"
  if [ "$t" = "error" ]; then
    msg="$(echo "$line" | jq -r '.message // "unknown"' 2>/dev/null)" || msg="unknown"
    log "wechat poll failed [$blabel]: $msg"
    if [ "$DRY" != "1" ]; then
      n="0"
      [ -f "$ff" ] && n="$(cat "$ff" 2>/dev/null || echo 0)"
      case "$n" in ''|*[!0-9]*) n=0 ;; esac
      n=$((n + 1))
      echo "$n" > "$ff" || log "wechat: failcount write failed for $short"
      if [ "$n" -ge 10 ]; then
        echo 0 > "$ff" || log "wechat: failcount reset failed for $short"
        # Diagnostic dedup (2026-11-12): a persistent failure wakes at most ONE
        # diagnostic worker per episode. If this bot was already reported
        # (marker exists), skip setting FAILING_BOT so no more diagnostic
        # workers are spawned for the same unchanging failure. The marker is
        # cleared on the next successful poll (recovery), so a later fresh
        # failure will be reported again.
        diagf="$DIAG_PREFIX.$short"
        if [ ! -f "$diagf" ]; then
          printf '%s %s\n' "$(date +%s)" "$msg" > "$diagf"
          # Remember the failing bot but do NOT wake yet: any collected messages
          # must be delivered first (their cursor was already advanced).
          FAILING_BOT="$(jq -n --arg bid "$bid" --arg bl "$blabel" --argjson n "$n" \
            '{botId:$bid,botLabel:$bl,consecutive_failures:$n}')" || FAILING_BOT=""
        fi
      fi
    fi
  elif [ "$t" = "messages" ]; then
    [ "$DRY" != "1" ] && echo 0 > "$ff"
    # Recovery: a successful poll clears the diagnostic marker, so a later
    # fresh failure episode will be reported again.
    [ "$DRY" != "1" ] && rm -f "$DIAG_PREFIX.$short"
    # Attach botId/botLabel to each message for routing.
    echo "$line" | jq -c '{botId, botLabel} as $b | .messages[]? | . + $b' 2>/dev/null >> "$MESSAGES_FILE" || true
  fi
done <<< "$POLL_OUT"

COUNT="$(jq -s 'length' "$MESSAGES_FILE" 2>/dev/null || echo 0)"
case "$COUNT" in ''|*[!0-9]*) COUNT=0 ;; esac

if [ "$COUNT" -gt 0 ]; then
  if [ "$DRY" = "1" ]; then
    rm -f "$MESSAGES_FILE"
    silent "dry run: $COUNT message(s) would be handled"
    exit 0
  fi
  # Buffer for ordered per-conversation delivery.
  # Buffer first (live mode only; dry-run exits above): the messages are
  # safe in the pending buffer before any slow media work, so a slow
  # download can never delay or lose them.
  # Stamp intake fields (V3 Task D/E, 2026-11-12): receivedAtMs = when this
  # poll received the message (cross-bot ordering must use it, not seq, which
  # is per-conversation and incomparable across bots); status = "pending".
  # Dedup by messageId against existing pending: a repeat poll of the same
  # message must not create a duplicate pending entry. If the dedup filter
  # fails, fall back to stamping without dedup (fail open: never lose a
  # message because of a filter error).
  _recv_ms="$(date +%s%3N)"
  # P1-2: mktemp fallback to a fixed temp file; a failed mktemp must not
  # kill the tick after the cursor has advanced.
  _new_msgs="$(mktemp)" || _new_msgs="$STATE_DIR/wechat-inbox.newmsgs.tmp"
  : > "$_new_msgs" || { log "wechat: intake temp file unavailable"; rm -f "$MESSAGES_FILE"; silent "temp file unavailable"; exit 0; }
  # P1-1: an empty-string messageId is treated exactly like a missing one —
  # it never joins the dedup key set, and a message with no usable id is
  # admitted without dedup (never silently dropped). P1-2: if BOTH jq
  # passes fail, fall back to appending the raw messages (duplicates
  # tolerated, loss not) instead of losing the batch.
  _intake_rc=0
  if [ -s "$PENDING_FILE" ]; then
    jq -c --slurpfile pend "$PENDING_FILE" --argjson now "$_recv_ms" '
      ([$pend[]?.messageId] | map(select(. != null and . != ""))) as $have |
      select(.messageId == null or .messageId == "" or (($have | index(.messageId)) == null))
      | . + {receivedAtMs: $now, status: "pending"}
    ' "$MESSAGES_FILE" > "$_new_msgs" 2>/dev/null || \
      jq -c --argjson now "$_recv_ms" '. + {receivedAtMs: $now, status: "pending"}' "$MESSAGES_FILE" > "$_new_msgs" 2>/dev/null || _intake_rc=1
  else
    jq -c --argjson now "$_recv_ms" '. + {receivedAtMs: $now, status: "pending"}' "$MESSAGES_FILE" > "$_new_msgs" 2>/dev/null || _intake_rc=1
  fi
  if [ "$_intake_rc" -ne 0 ]; then
    log "wechat: intake jq failed, falling back to raw append (count=$COUNT)"
    cat "$MESSAGES_FILE" >> "$PENDING_FILE" || log "wechat: intake fallback append failed"
  else
    cat "$_new_msgs" >> "$PENDING_FILE" || log "wechat: intake append failed"
  fi
  # Structured intake log (V3 §九, Fix 5): what arrived, when, and the
  # queue size after buffering — so the log alone can answer "was it
  # received / queued / how many are waiting".
  if [ "$_intake_rc" -ne 0 ]; then
    _in_count="$COUNT"
  else
    _in_count="$(jq -s 'length' "$_new_msgs" 2>/dev/null || echo 0)"
  fi
  case "$_in_count" in ''|*[!0-9]*) _in_count=0 ;; esac
  _deduped=$((COUNT - _in_count))
  case "$_deduped" in ''|*[!0-9]*) _deduped=0 ;; esac
  _in_bots="$(jq -r -s 'map(.botId) | unique | join(",")' "$_new_msgs" 2>/dev/null || echo "?")"
  rm -f "$_new_msgs"
  _pend_total="$(pending_count)"
  log "wechat: intake receivedAtMs=$_recv_ms count=$_in_count deduped=$_deduped pending_total=$_pend_total bots=${_in_bots:-?}" || true
  # Intake media pass: short patience on this run's new media; successes get
  # localPath written back into the buffered records. Failures are NOT
  # final: the wake pass retries with full patience before waking a worker.
  intake_download "$MESSAGES_FILE"
  # Maintain a roster of (bot -> users) seen, for quota-exhaustion notices.
  # Shared across per-bot hook instances: guard with a lock.
  (
    flock -n 200 || exit 0
    [ -f "$ROSTER_FILE" ] || echo '{}' > "$ROSTER_FILE"
    jq -c '{botId, fromUserId}' "$MESSAGES_FILE" 2>/dev/null | jq -s '
      reduce .[] as $p ({}; .[$p.botId] |= ((. // []) + [$p.fromUserId] | unique))
    ' > "$STATE_DIR/roster.new" 2>/dev/null
    if [ -s "$STATE_DIR/roster.new" ]; then
      # Roster prune (2026-11-12): drop botIds no longer in the current
      # $BOTS list, so retired bots (e.g. 4b960497) stop accumulating
      # forever — the old merge was add-only.
      bots_json="$(printf '%s\n' "$BOTS" | cut -f1 | jq -R -s -c 'split("\n") | map(select(length > 0))')"
      jq -s --argjson bots "$bots_json" '.[0] as $old | .[1] as $new |
        ((($old | keys) + ($new | keys)) | unique) |
        map(select(. as $k | ($bots | index($k) != null))) |
        map({key: ., value: ((($old[.] // []) + ($new[.] // [])) | unique)}) |
        from_entries' "$ROSTER_FILE" "$STATE_DIR/roster.new" > "$ROSTER_FILE.tmp" 2>/dev/null \
      && mv "$ROSTER_FILE.tmp" "$ROSTER_FILE"
    fi
    rm -f "$STATE_DIR/roster.new" "$ROSTER_FILE.tmp"
  ) 200>"$ROSTER_LOCK" || true
  rm -f "$MESSAGES_FILE"
  # Transition: an old-style (global-lock) worker may still be running; let it
  # finish its batch before the per-conversation scheme takes over.
  if lock_busy "$LEGACY_WORKER_LOCK"; then
    silent "legacy worker busy, $(pending_count) message(s) buffered"
    exit 0
  fi
  rm -f "$LEGACY_WORKER_LOCK"
  if wake_idle_for_pending "$FAILING_BOT"; then
    exit 0
  fi
  # M-2 (2026-11-12): all conversations busy — the messages stay in pending
  # and will be woken on a later tick, but the failing-bot diagnostic must
  # still go out now. Otherwise this episode is never reported (the dedup
  # marker blocks every later 10th failure too), so wake it before exiting.
  # Priority note (V3 Task F): this is the SOLE case where a diagnostic is
  # dispatched while user messages are still pending — and only because the
  # episode would otherwise be lost entirely. A diagnostic is never woken
  # in the same tick as a user worker (the wake above exits first).
  if [ -n "$FAILING_BOT" ] && [ "$DRY" != "1" ]; then
    _fb_id="$(printf '%s' "$FAILING_BOT" | jq -r '.botId // "?"' 2>/dev/null || echo "?")"
    log "wechat: dispatch diagnostic bot=${_fb_id:-?} status=dispatched queue_remaining=$(pending_count)"
    wake "wechat_poll_failing" "$FAILING_BOT"
    exit 0
  fi
  silent "all conversations busy, $(pending_count) message(s) buffered"
  exit 0
fi

rm -f "$MESSAGES_FILE"

# No new messages: wake one worker for buffered messages if any conversation
# is idle.
if [ "$DRY" != "1" ]; then
  if lock_busy "$LEGACY_WORKER_LOCK"; then
    silent "legacy worker busy"
    exit 0
  fi
  rm -f "$LEGACY_WORKER_LOCK"
  if wake_idle_for_pending "$FAILING_BOT"; then
    exit 0
  fi
fi

if [ -n "$FAILING_BOT" ] && [ "$DRY" != "1" ]; then
  wake "wechat_poll_failing" "$FAILING_BOT"
  exit 0
fi
silent "no new messages"
exit 0
