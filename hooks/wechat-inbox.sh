#!/usr/bin/env bash
# WeChat inbox watcher — ONE hook instance per bot.
#
# Bot selection comes from the WECHAT_BOT_SEL environment variable, set by the
# per-window wrapper script (wechat-inbox-<sel>.sh). When set: single-bot mode
# (poll --bot <sel> only, state files namespaced by <sel>). When unset: legacy
# all-bots mode (poll-all).
# Single-bot mode is the current architecture: each WeChat window (bot) gets
# its own hook, whose worker summaries are delivered to that window's own
# mirror side chat (hook delivery is a single fixed target, so per-window
# mirrors require per-window hooks).
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
CLI="node /home/hatch/workspace/skills/wechat-bot/dist/cli.js"
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

# 消息状态机：queued -> processing -> replied -> mirrored
# 超时300秒未完成的processing，重入队（最多3次），超限进死信
DEAD_LETTER="$STATE_DIR/wechat-dead-letter.jsonl"
MAX_RETRY=3

# 检查超时的processing消息，重入队或进死信
requeue_timed_out() {
  [ -s "$PENDING_FILE" ] || return 0
  local now tmpfile
  now=$(date +%s)
  tmpfile="$PENDING_FILE.tmp"
  jq -c --argjson now "$now" --argjson ttl "$WORKER_TTL" --argjson maxr "$MAX_RETRY" '
    . as $msg |
    if ($msg._state == "processing" and ($now - ($msg._processing_since // 0)) > $ttl) then
      ($msg._retry // 0) as $r |
      if $r >= $maxr then
        # 进死信（由shell写文件，这里标记）
        $msg + {_dead: true}
      else
        # 重入队
        $msg + {_state: "queued", _retry: ($r + 1)} | del(._processing_since)
      end
    else .
    end
  ' "$PENDING_FILE" 2>/dev/null > "$tmpfile" || return 0
  # 把死信写出去
  jq -c 'select(._dead)' "$tmpfile" 2>/dev/null | while read -r dl; do
    echo "$dl" | jq -c '{ts: now, message: del(._dead, ._state, ._retry, ._processing_since)}' >> "$DEAD_LETTER"
  done
  # 过滤掉死信，写回
  jq -c 'select(._dead | not)' "$tmpfile" 2>/dev/null > "$PENDING_FILE" || true
  rm -f "$tmpfile"
}

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
            .key as $idx |
            .value as $m |
            # 这里只标记，实际下载由下面的shell循环做
            $m + { _idx: $idx }
          )) as $marked |
          $msg + { _media_to_dl: $marked }
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
        ext="bin"
        case "$kind" in
          image) ext="jpg" ;;
          voice) ext="silk" ;;
          video) ext="mp4" ;;
          file) ext="dat" ;;
        esac
        out="$MEDIA_DIR/${mid}_${idx}.${ext}"
        # 下载带重试：消息通知到达时 CDN 上的文件可能还没就绪，单次失败不代表真失败
        # （实测 12:28 那次 3 次×5 秒都不够，CDN 经常要几十秒才就绪）
        dl_ok=""
        for attempt in 1 2 3 4 5 6; do
          if [ -n "$furl" ]; then
            "$CLI" download-media --aes-key "$aes" --full-url "$furl" --out "$out" >/dev/null 2>&1
          elif [ -n "$eparam" ]; then
            "$CLI" download-media --aes-key "$aes" --enc-param "$eparam" --out "$out" >/dev/null 2>&1
          else
            break
          fi
          if [ -f "$out" ]; then dl_ok="1"; break; fi
          sleep 10
        done
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
# 每轮先检查超时的processing消息
requeue_timed_out
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
