#!/usr/bin/env bash
# WeChat inbox watcher — ONE hook instance per bot.
#
# Bot selection comes from the WECHAT_BOT_SEL environment variable, set by the
# per-window wrapper script (wechat-inbox-<sel>.sh). When set: single-bot mode
# (poll --bot <sel> only, state files namespaced by <sel>). When unset: legacy
# all-bots mode (poll-all).
# Single-bot mode is the current architecture: each WeChat window (bot) gets
# its own hook, whose worker is delivered to that window's own work chat
# (hook delivery is a single fixed target, so per-window delivery requires
# per-window hooks).
#
# Ordering: each CONVERSATION (bot + user) is handled by at most ONE worker at
# a time (per-conversation lock file). Different conversations get their own
# workers in parallel and never block each other; messages inside one
# conversation are always delivered in chronological (seq) order, so a single
# conversation's replies can never overtake each other.
# NOTE: no auto-reply/ack — the user cancelled it. The worker sends the
# substantive reply directly; expect worker cold-start latency (~tens of secs).
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

DRY="${HATCH_HOOK_DRY_RUN:-0}"
SKILL_DIR="${WECHAT_BOT_SKILL_DIR:-$HOME/workspace/skills/wechat-bot}"
CLI="node $SKILL_DIR/dist/cli.js"
STATE_DIR="$HOME/hooks/state"
LOCK_FILE="$STATE_DIR/wechat-inbox.lock"
NOTIFY_PREFIX="$STATE_DIR/wechat-inbox.notifystart"
FAIL_PREFIX="$STATE_DIR/wechat-inbox.failcount"
LEGACY_WORKER_LOCK="$STATE_DIR/wechat-inbox.worker"   # pre-2026-09-28 global lock (transition only)
WORKER_LOCK_PREFIX="$STATE_DIR/wechat-inbox.worker."
ROSTER_FILE="$STATE_DIR/wechat-roster.json"
ROSTER_LOCK="$STATE_DIR/wechat-roster.lock"
WORKER_TTL=300
SEP=$'\x01'

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

media_ext() {
  case "$1" in
    image) echo jpg ;;
    voice) echo silk ;;
    video) echo mp4 ;;
    *) echo dat ;;
  esac
}

# Download one media file with retries. The file lands under a temp name
# first and is renamed only on success, so a half-written file can never
# pose as a completed download. An already-present final file counts as
# done (deterministic names make re-runs idempotent).
SILK_DECODER="${WECHAT_SILK_DECODER:-$HOME/workspace/tools/silk-v3-decoder/silk/decoder}"

# WeChat voice (.silk) cannot play in a browser; transcode a sibling .mp3
# next to it so the conversation viewer can offer a playable voice bar.
# Best effort only: any failure leaves the .silk as-is and changes nothing.
transcode_voice() {
  local silk="$1" mp3="${1%.silk}.mp3" pcm
  [ -s "$mp3" ] && return 0
  [ -x "$SILK_DECODER" ] || return 1
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

try_download() {
  local aes="$1" furl="$2" eparam="$3" out="$4" attempts="$5"
  if [ -s "$out" ]; then
    case "$out" in *.silk) transcode_voice "$out" || true ;; esac
    return 0
  fi
  local tmp="${out}.part" attempt
  rm -f "$tmp"
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if [ -n "$furl" ]; then
      $CLI download-media --aes-key "$aes" --full-url "$furl" --out "$tmp" >/dev/null 2>&1
    elif [ -n "$eparam" ]; then
      $CLI download-media --aes-key "$aes" --enc-param "$eparam" --out "$tmp" >/dev/null 2>&1
    else
      rm -f "$tmp"
      return 1
    fi
    if [ -s "$tmp" ]; then
      mv "$tmp" "$out"
      case "$out" in *.silk) transcode_voice "$out" || true ;; esac
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then sleep 10; fi
  done
  rm -f "$tmp"
  return 1
}

# Intake media pass (hybrid download, step 2): the messages are already in
# the pending buffer (buffer first, nothing can be lost from here on). Try
# to fetch this run's new media right away with short patience; successes
# get their localPath written back into the buffered records. A failure is
# NOT final: the wake pass retries with full patience, and the worker has
# its own fallback after that.
intake_download() {
  local src="$1"
  local ok_list mid tmp_p
  ok_list="$(mktemp)"
  MEDIA_DIR="$HOME/workspace/wechat-media/$(date +%Y-%m-%d)"
  mkdir -p "$MEDIA_DIR"
  jq -c 'select(.media) | {messageId, media}' "$src" 2>/dev/null | while read -r line; do
    mid="$(echo "$line" | jq -r '.messageId')"
    echo "$line" | jq -c '.media | to_entries[] | {idx: .key, m: .value}' | while read -r e; do
      local idx kind aes furl eparam out
      idx="$(echo "$e" | jq -r '.idx')"
      kind="$(echo "$e" | jq -r '.m.kind')"
      aes="$(echo "$e" | jq -r '.m.aesKey // empty')"
      furl="$(echo "$e" | jq -r '.m.fullUrl // empty')"
      eparam="$(echo "$e" | jq -r '.m.encryptedQueryParam // empty')"
      [ -n "$aes" ] || continue
      out="$MEDIA_DIR/${mid}_${idx}.$(media_ext "$kind")"
      if try_download "$aes" "$furl" "$eparam" "$out" 3; then
        log "wechat: media downloaded (intake) $out"
        echo "${mid}_${idx}" >> "$ok_list"
      else
        log "wechat: media intake deferred mid=$mid idx=$idx kind=$kind"
      fi
    done
  done
  if [ -s "$ok_list" ] && [ -f "$PENDING_FILE" ]; then
    tmp_p="$(mktemp)"
    if jq -s -c --arg mdir "$MEDIA_DIR" --slurpfile ok <(jq -R -s 'split("\n")|map(select(length>0))' "$ok_list") '
      .[] | .messageId as $mid |
      if .media then
        .media = (.media | to_entries | map(
          .key as $i | .value as $m |
          if (($ok[0] | index("\($mid)_\($i)")) and ($m.localPath == null))
          then $m + { localPath: "\($mdir)/\($mid)_\($i).\(if $m.kind == "image" then "jpg" elif $m.kind == "voice" then "silk" elif $m.kind == "video" then "mp4" else "dat" end)" }
          else $m
          end
        ))
      else .
      end
    ' "$PENDING_FILE" > "$tmp_p" 2>/dev/null; then
      mv "$tmp_p" "$PENDING_FILE"
    else
      rm -f "$tmp_p"
    fi
  fi
  rm -f "$ok_list"
}

# Wake ONE worker for the oldest-waiting conversation whose lock is free.
# Extracts that conversation's messages (chronological by seq) from the
# pending buffer, takes its lock, and wakes.
wake_one_for_pending() {
  local failing="$1"
  [ -s "$PENDING_FILE" ] || return 1
  local keys k h lf msgs rest payload
  keys="$(jq -s -r --arg sep "$SEP" '
    [ .[] | {k: (.botId + $sep + .fromUserId), s: (.seq // 0)} ]
    | group_by(.k)
    | map({k: .[0].k, oldest: (map(.s) | min)})
    | sort_by(.oldest) | .[].k
  ' "$PENDING_FILE" 2>/dev/null)"
  [ -n "$keys" ] || return 1
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    h="$(key_hash "$k")"
    lf="$WORKER_LOCK_PREFIX$h"
    if lock_busy "$lf"; then
      continue
    fi
    date +%s > "$lf"
    msgs="$(jq -s -c --arg k "$k" --arg sep "$SEP" '
      [ .[] | select((.botId + $sep + .fromUserId) == $k) ] | sort_by(.seq, .messageId)
    ' "$PENDING_FILE" 2>/dev/null)"
    if [ -z "$msgs" ] || [ "$msgs" = "[]" ]; then
      rm -f "$lf"
      continue
    fi
    rest="$(jq -s -c --arg k "$k" --arg sep "$SEP" '
      .[] | select((.botId + $sep + .fromUserId) != $k)
    ' "$PENDING_FILE" 2>/dev/null)"
    if [ -n "$rest" ]; then
      printf '%s\n' "$rest" > "$PENDING_FILE"
    else
      rm -f "$PENDING_FILE"
    fi
    if [ -n "$failing" ]; then
      payload="$(jq -n --argjson msgs "$msgs" --arg lf "$lf" --argjson fb "$failing" \
        '{type:"messages", count: ($msgs|length), messages: $msgs, lockFile: $lf, failingBot: $fb}')"
    else
      payload="$(jq -n --argjson msgs "$msgs" --arg lf "$lf" \
        '{type:"messages", count: ($msgs|length), messages: $msgs, lockFile: $lf}')"
    fi
    # 自动下载媒体：worker唤醒前就把图片/语音/视频/文件下好，不依赖worker自觉
    MEDIA_DIR="$HOME/workspace/wechat-media/$(date +%Y-%m-%d)"
    mkdir -p "$MEDIA_DIR"
    payload="$(echo "$payload" | jq -c --arg mdir "$MEDIA_DIR" --arg cli "$CLI" '
      .messages |= map(
        . as $msg |
        ($msg.media // []) as $media |
        if ($media | length) == 0 then $msg
        else
          ($media | to_entries | map(
            select(.value.localPath == null) |
            .key as $idx |
            .value as $m |
            # 这里只标记还没下好的（入队时下成功的带 localPath，跳过），
            # 实际下载由下面的shell循环做
            $m + { _idx: $idx }
          )) as $marked |
          if ($marked | length) == 0 then $msg
          else $msg + { _media_to_dl: $marked }
          end
        end
      )
    ')"
    # 逐条下载（只记录真正下载成功的文件，失败的不写 localPath）
    DL_OK_LIST="$(mktemp)"
    echo "$payload" | jq -c '.messages[] | select(._media_to_dl) | {messageId, _media_to_dl}' | while read -r line; do
      mid="$(echo "$line" | jq -r '.messageId')"
      echo "$line" | jq -c '._media_to_dl[]' | while read -r m; do
        kind="$(echo "$m" | jq -r '.kind')"
        aes="$(echo "$m" | jq -r '.aesKey // empty')"
        furl="$(echo "$m" | jq -r '.fullUrl // empty')"
        eparam="$(echo "$m" | jq -r '.encryptedQueryParam // empty')"
        idx="$(echo "$m" | jq -r '._idx')"
        [ -n "$aes" ] || continue
        ext="$(media_ext "$kind")"
        out="$MEDIA_DIR/${mid}_${idx}.${ext}"
        # 下载带重试：消息通知到达时 CDN 上的文件可能还没就绪，单次失败不代表真失败
        # （实测 12:28 那次 3 次×5 秒都不够，CDN 经常要几十秒才就绪）
        # 这里只下入队时没下成的，用足耐心 6 次×10 秒；try_download 经临时名
        # 落盘、成功才改正式名，防半截文件冒充成功。
        dl_ok=""
        if try_download "$aes" "$furl" "$eparam" "$out" 6; then
          dl_ok="1"
        fi
        if [ -n "$dl_ok" ]; then
          log "wechat: media downloaded $out"
          echo "${mid}_${idx}" >> "$DL_OK_LIST"
        else
          log "wechat: media download FAILED mid=$mid idx=$idx kind=$kind"
        fi
      done
    done
    # 把本地路径写回payload：只给下载成功的加 localPath（messageId 要在内层 map 之前取出，
    # 之前写在 to_entries 的 map 里取 .messageId 拿到的是 null，导致 localPath 全是 null_0.jpg）
    payload="$(echo "$payload" | jq -c --arg mdir "$MEDIA_DIR" --slurpfile ok <(jq -R -s 'split("\n")|map(select(length>0))' "$DL_OK_LIST") '
      .messages |= map(
        .messageId as $mid |
        if ._media_to_dl then
          .media = (.media | to_entries | map(
            .key as $idx |
            .value as $m |
            ($m.kind) as $k |
            (if $k == "image" then "jpg" elif $k == "voice" then "silk" elif $k == "video" then "mp4" else "dat" end) as $ext |
            ("\($mid)_\($idx)") as $id |
            if ($ok[0] | index($id)) then $m + { localPath: "\($mdir)/\($id).\($ext)" } else $m end
          )) | del(._media_to_dl)
        else .
        end
      )
    ')"
    rm -f "$DL_OK_LIST"
    wake "wechat_new_messages" "$payload"
    exit 0
  done <<< "$keys"
  return 1
}

# Bot list as "<id>\t<label>" lines (filtered to our bot in single-bot mode).
if [ -n "$BOT_SEL" ]; then
  BOTS="$($CLI status 2>/dev/null | jq -r --arg sel "$BOT_SEL" \
    '.bots[]? | select(.id | startswith($sel)) | "\(.id)\t\(.label)"')"
else
  BOTS="$($CLI status 2>/dev/null | jq -r '.bots[]? | "\(.id)\t\(.label)"')"
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
      if $CLI notify-start --bot "$bid" >/dev/null 2>&1; then
        echo "$now" > "$nf"
      else
        log "wechat notify-start failed for [$blabel]"
      fi
    fi
  done <<< "$BOTS"
fi

# Poll: single bot in single-bot mode, all bots in legacy mode.
if [ -n "$BOT_SEL" ]; then
  POLL_OUT="$($CLI poll --bot "$BOT_SEL" --timeout-ms 7000 2>/dev/null)" || {
    log "wechat poll crashed"
    silent "poll crashed"
    exit 0
  }
else
  POLL_OUT="$($CLI poll-all --timeout-ms 7000 2>/dev/null)" || {
    log "wechat poll-all crashed"
    silent "poll-all crashed"
    exit 0
  }
fi

MESSAGES_FILE="$(mktemp)"
FAILING_BOT=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  t="$(echo "$line" | jq -r '.type // ""' 2>/dev/null)"
  bid="$(echo "$line" | jq -r '.botId // ""' 2>/dev/null)"
  blabel="$(echo "$line" | jq -r '.botLabel // ""' 2>/dev/null)"
  short="${bid:0:8}"
  [ -n "$short" ] || continue
  ff="$FAIL_PREFIX.$short"
  if [ "$t" = "error" ]; then
    msg="$(echo "$line" | jq -r '.message // "unknown"' 2>/dev/null)"
    log "wechat poll failed [$blabel]: $msg"
    if [ "$DRY" != "1" ]; then
      n="0"
      [ -f "$ff" ] && n="$(cat "$ff" 2>/dev/null || echo 0)"
      case "$n" in ''|*[!0-9]*) n=0 ;; esac
      n=$((n + 1))
      echo "$n" > "$ff"
      if [ "$n" -ge 10 ]; then
        echo 0 > "$ff"
        # Remember the failing bot but do NOT wake yet: any collected messages
        # must be delivered first (their cursor was already advanced).
        FAILING_BOT="$(jq -n --arg bid "$bid" --arg bl "$blabel" --argjson n "$n" \
          '{botId:$bid,botLabel:$bl,consecutive_failures:$n}')"
      fi
    fi
  elif [ "$t" = "messages" ]; then
    [ "$DRY" != "1" ] && echo 0 > "$ff"
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
  cat "$MESSAGES_FILE" >> "$PENDING_FILE"
  # Maintain a roster of (bot -> users) seen, for quota-exhaustion notices.
  # Shared across per-bot hook instances: guard with a lock.
  (
    flock -n 200 || exit 0
    [ -f "$ROSTER_FILE" ] || echo '{}' > "$ROSTER_FILE"
    jq -c '{botId, fromUserId}' "$MESSAGES_FILE" 2>/dev/null | jq -s '
      reduce .[] as $p ({}; .[$p.botId] |= ((. // []) + [$p.fromUserId] | unique))
    ' > "$STATE_DIR/roster.new" 2>/dev/null
    if [ -s "$STATE_DIR/roster.new" ]; then
      jq -s '.[0] as $old | .[1] as $new |
        ((($old | keys) + ($new | keys)) | unique) |
        map({key: ., value: ((($old[.] // []) + ($new[.] // [])) | unique)}) |
        from_entries' "$ROSTER_FILE" "$STATE_DIR/roster.new" > "$ROSTER_FILE.tmp" 2>/dev/null \
      && mv "$ROSTER_FILE.tmp" "$ROSTER_FILE"
    fi
    rm -f "$STATE_DIR/roster.new" "$ROSTER_FILE.tmp"
  ) 200>"$ROSTER_LOCK"
  # 结合版第二步：消息已落盘（底账先行），紧接着试下这一批的媒体；
  # 下好的把 localPath 回写进缓冲记录，下不成的留给唤醒时足耐心再下。
  intake_download "$MESSAGES_FILE"
  rm -f "$MESSAGES_FILE"
  # Transition: an old-style (global-lock) worker may still be running; let it
  # finish its batch before the per-conversation scheme takes over.
  if lock_busy "$LEGACY_WORKER_LOCK"; then
    silent "legacy worker busy, $(pending_count) message(s) buffered"
    exit 0
  fi
  rm -f "$LEGACY_WORKER_LOCK"
  if wake_one_for_pending "$FAILING_BOT"; then
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
  if wake_one_for_pending "$FAILING_BOT"; then
    exit 0
  fi
fi

if [ -n "$FAILING_BOT" ] && [ "$DRY" != "1" ]; then
  wake "wechat_poll_failing" "$FAILING_BOT"
  exit 0
fi
silent "no new messages"
exit 0
