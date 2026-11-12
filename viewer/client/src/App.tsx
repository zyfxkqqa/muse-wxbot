import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileToBase64 } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Overview = ApiResponse<typeof api, "getOverview">;
type Bot = Overview["bots"][number];
type Conversation = Bot["conversations"][number];
type MessagesData = ApiResponse<typeof api, "getMessages">;

const POLL_MS = 8000;

/* ---------- small inline icons (no icon font, no emoji) ---------- */

function Icon({
  d,
  className,
}: {
  d: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "h-4 w-4"}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const PATHS = {
  search: "M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm10 16-4.3-4.3",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5",
  chevronUp: "m6 15 6-6 6 6",
  chevronDown: "m6 9 6 6 6-6",
  chevronLeft: "m15 18-6-6 6-6",
  chevronRight: "m9 18 6-6-6-6",
  pencil: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z",
  x: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6",
  paperclip:
    "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
};

/** Human-readable file size for the attachment chip (B / KB / MB). */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Client-side attachment rules, mirroring the server (which re-checks
 * everything): video (mp4/mov/webm) is capped at 5 MiB by the platform,
 * voice can only be an existing .silk file, and nothing over 20 MiB goes
 * out at all.
 * Returns the error to show, or null when the file may be sent.
 */
function validateAttachment(file: File): string | null {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (ext === "mp3") return "语音只能发 .silk 文件，mp3 发不出去";
  if (["m4a", "wav", "ogg", "aac", "flac", "amr"].includes(ext))
    return "语音只能发 .silk 文件，当前音频格式发不出去";
  if (
    (ext === "mp4" || ext === "mov" || ext === "webm") &&
    file.size > 5 * 1024 * 1024
  )
    return "视频超过 5MB，平台发不出去，请压缩或裁剪后再发";
  if (file.size > 20 * 1024 * 1024)
    return "文件太大（超过 20MB），发不出去";
  return null;
}

/**
 * Client-side .silk magic check, mirroring the server and CLI rule: a
 * voice file must start with the SILK_V3 magic at offset 0 or 1 (real
 * WeChat .silk files carry a leading 0x02 byte). Only the first 10 bytes
 * are read, so a bad file is rejected before the base64 upload starts.
 * Returns the error to show, or null when the file passes (or is not .silk).
 */
async function validateSilkMagic(file: File): Promise<string | null> {
  if (!file.name.toLowerCase().endsWith(".silk")) return null;
  let head: string;
  try {
    const buf = await file.slice(0, 10).arrayBuffer();
    head = new TextDecoder("ascii").decode(buf);
  } catch {
    return "语音文件读取失败，请重新选择";
  }
  if (
    !head.startsWith("#!SILK_V3") &&
    !head.slice(1).startsWith("#!SILK_V3")
  ) {
    return "语音只能发 .silk 文件，当前文件不是有效的 .silk 格式";
  }
  return null;
}

/* ---------- avatars ---------- */

/**
 * Two fixed identity tiles, drawn (not photos): the robot side is Muse,
 * the phone side is 微信. Text tiles keep the two sides unambiguous at a
 * glance, which is exactly what the user asked the avatars for.
 */
function SideAvatar({ side, size = 38 }: { side: "muse" | "wechat"; size?: number }) {
  if (side === "muse") {
    return (
      <div
        aria-hidden="true"
        className="flex shrink-0 select-none items-center justify-center rounded-lg font-semibold text-white shadow-sm"
        style={{
          width: size,
          height: size,
          backgroundColor: "#2f3542",
          fontSize: size >= 44 ? 13 : 10,
          letterSpacing: "-0.02em",
        }}
      >
        Muse
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 select-none items-center justify-center rounded-lg font-semibold text-white shadow-sm"
      style={{
        width: size,
        height: size,
        backgroundColor: "var(--accent)",
        fontSize: size >= 44 ? 15 : 12,
      }}
    >
      微信
    </div>
  );
}

/* ---------- time formatting ----------
 * Every displayed time is Beijing time (Asia/Shanghai, UTC+8), no matter
 * which offset the stored ts carried and no matter which timezone the
 * viewer's browser is in. All fields come from Intl.DateTimeFormat pinned
 * to Asia/Shanghai — never from Date's local getters. */

const BEIJING_TZ = "Asia/Shanghai";

const beijingPartsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: BEIJING_TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

interface BeijingParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: string; // "00"-"23", zero-padded
  minute: string; // "00"-"59", zero-padded
}

function beijingParts(d: Date): BeijingParts {
  const fields: Record<string, string> = {};
  for (const part of beijingPartsFmt.formatToParts(d)) {
    fields[part.type] = part.value;
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: fields.hour ?? "00",
    minute: fields.minute ?? "00",
  };
}

function parseTs(ts: string): Date | null {
  if (!ts) return null;
  const raw = ts.trim();
  // A timestamp with no offset is in Beijing time per the history format;
  // pin it before parsing, otherwise Date reads it as browser-local time.
  const hasTime = /[T ]\d{2}:\d{2}/.test(raw);
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})\s*$/i.test(raw);
  const candidate =
    hasTime && !hasOffset ? `${raw.replace(" ", "T")}+08:00` : raw;
  const d = new Date(candidate);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayKey(d: Date): string {
  const p = beijingParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Beijing calendar-day number, for 今天/昨天 comparisons by Beijing date. */
function beijingDayNumber(d: Date): number {
  const p = beijingParts(d);
  return Date.UTC(p.year, p.month - 1, p.day) / 86400000;
}

function dayLabel(d: Date): string {
  const p = beijingParts(d);
  const diffDays = beijingDayNumber(new Date()) - beijingDayNumber(d);
  const hm = `${p.hour}:${p.minute}`;
  if (diffDays === 0) return hm;
  if (diffDays === 1) return `昨天 ${hm}`;
  return `${p.year}年${p.month}月${p.day}日 ${hm}`;
}

function clockLabel(d: Date): string {
  const p = beijingParts(d);
  return `${p.hour}:${p.minute}`;
}

function dateLabel(ts: string): string {
  const d = parseTs(ts);
  if (!d) return "";
  const p = beijingParts(d);
  return `${p.year}年${p.month}月${p.day}日`;
}

/** Current Beijing wall-clock time as ISO with +08:00 and no milliseconds —
 *  the exact shape history lines use (for the optimistically appended
 *  message the user just sent; the server line replaces it on refetch). */
function beijingNowIso(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "+08:00");
}

/* ---------- highlighted message text ---------- */

function HighlightedText({
  text,
  query,
  isActiveMatch,
}: {
  text: string;
  query: string;
  isActiveMatch: boolean;
}) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: Array<{ str: string; hit: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push({ str: text.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ str: text.slice(i, idx), hit: false });
    parts.push({ str: text.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return (
    <>
      {parts.map((p, k) =>
        p.hit ? (
          <mark
            key={k}
            className={
              isActiveMatch
                ? "rounded-sm bg-amber-400 px-px text-inherit"
                : "rounded-sm bg-amber-200 px-px text-inherit"
            }
          >
            {p.str}
          </mark>
        ) : (
          <span key={k}>{p.str}</span>
        ),
      )}
    </>
  );
}

/* ---------- message media attachments ---------- */

type MediaItem = { kind: string; localPath: string };

type ChatMessage = MessagesData["messages"][number];

/**
 * A media message's stored text is often just the placeholder "[图片]",
 * "[视频]", "[语音]" or "[文件]": the rendered attachment replaces that
 * text, so the bubble hides it. Search uses the same visible-text view
 * (visibleTextOf) — a hidden placeholder must not count as a search hit
 * either.
 */
function hidesPlaceholderText(m: ChatMessage): boolean {
  if (!m.media || m.media.length === 0) return false;
  const t = m.text.trim();
  return (
    t === "[图片]" || t === "[视频]" || t === "[语音]" || t === "[文件]"
  );
}

function visibleTextOf(m: ChatMessage): string {
  return hidesPlaceholderText(m) ? "" : m.text;
}

/**
 * Fetched media files, cached by localPath at module level: a file is
 * fetched through the getMedia action exactly once, no matter how often the
 * 8-second poll re-renders the conversation. `null` = fetch failed / file
 * gone, rendered as a quiet fallback line. The served MIME type rides along
 * because voice rendering depends on it: the server may hand back an .mp3
 * transcode for a .silk path, and only a playable audio MIME gets a player.
 */
type FetchedMedia = { url: string; mimeType: string };

const mediaUrlCache = new Map<string, Promise<FetchedMedia | null>>();

function fetchMediaUrl(localPath: string): Promise<FetchedMedia | null> {
  let pending = mediaUrlCache.get(localPath);
  if (!pending) {
    pending = api
      .getMedia({ localPath })
      .then((res) => {
        if (!res.found || !res.dataBase64) return null;
        const binary = atob(res.dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const mimeType = res.mimeType || "application/octet-stream";
        return {
          url: URL.createObjectURL(new Blob([bytes], { type: mimeType })),
          mimeType,
        };
      })
      .catch(() => null);
    mediaUrlCache.set(localPath, pending);
  }
  return pending;
}

/**
 * Media fetch as a query, gated by `enabled`: with enabled=false nothing is
 * fetched at all (file attachments wait for an explicit download tap).
 * `data` keeps the old tri-state — undefined while loading or not yet
 * wanted, null when the fetch failed, the FetchedMedia when it succeeded.
 */
function useMediaUrl(localPath: string, enabled = true) {
  const q = useQuery({
    queryKey: ["media", localPath],
    queryFn: () => fetchMediaUrl(localPath),
    enabled,
    staleTime: Infinity,
  });
  const data: FetchedMedia | null | undefined = enabled ? q.data : undefined;
  return { q, data, url: data?.url };
}

function mediaFilename(localPath: string): string {
  const name = localPath.split("/").pop() ?? "";
  return name || "附件";
}

function MediaView({ item }: { item: MediaItem }) {
  if (item.kind === "voice") {
    return <VoiceMediaView item={item} />;
  }
  return <FetchedMediaView item={item} />;
}

function VoiceMediaView({ item }: { item: MediaItem }) {
  const { data: media } = useMediaUrl(item.localPath);
  // The server serves a same-named .mp3 transcode when one exists; only
  // then is there a browser-playable audio stream. A raw .silk (or a failed
  // fetch) falls back to the marker — the transcription is the message text.
  const playable =
    media != null &&
    media.mimeType.startsWith("audio/") &&
    media.mimeType !== "audio/silk";
  if (playable) {
    return (
      <audio
        src={media.url}
        controls
        preload="metadata"
        aria-label="语音消息"
        className="mb-1 max-w-full"
      />
    );
  }
  return (
    <span className="mb-1 flex items-center gap-1.5 text-xs opacity-80">
      <Icon d={PATHS.mic} className="h-4 w-4" />
      语音消息（转写见正文）
    </span>
  );
}

function FetchedMediaView({ item }: { item: MediaItem }) {
  const isFile = item.kind !== "image" && item.kind !== "video";
  /* Files are not fetched up front: the bubble shows a download button and
   * the bytes are pulled only after the user taps it; once they arrive, the
   * download starts on its own (downloadStarted fires it exactly once). */
  const [wanted, setWanted] = useState(false);
  const downloadStarted = useRef(false);
  const { data: media } = useMediaUrl(item.localPath, !isFile || wanted);
  useEffect(() => {
    if (!isFile || !wanted || !media || downloadStarted.current) return;
    downloadStarted.current = true;
    const a = document.createElement("a");
    a.href = media.url;
    a.download = mediaFilename(item.localPath);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [isFile, wanted, media, item.localPath]);
  if (isFile && !wanted) {
    return (
      <button
        type="button"
        onClick={() => setWanted(true)}
        className="flex items-center gap-2 py-1 underline decoration-dotted underline-offset-2"
      >
        <Icon d={PATHS.file} className="h-5 w-5 shrink-0" />
        <span className="min-w-0 break-all text-sm">
          下载 {mediaFilename(item.localPath)}
        </span>
        <Icon d={PATHS.download} className="h-4 w-4 shrink-0" />
      </button>
    );
  }
  if (media === undefined) {
    return (
      <span className="block py-2 text-xs opacity-70">媒体加载中…</span>
    );
  }
  if (media === null) {
    return (
      <span className="block py-2 text-xs opacity-70">媒体文件读取失败</span>
    );
  }
  const url = media.url;
  if (item.kind === "image") {
    return (
      <img
        src={url}
        alt="消息中的图片"
        className="max-h-72 max-w-full rounded-md"
        loading="lazy"
      />
    );
  }
  if (item.kind === "video") {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        aria-label="消息中的视频"
        className="max-h-72 max-w-full rounded-md bg-black"
      />
    );
  }
  return (
    <a
      href={url}
      download={mediaFilename(item.localPath)}
      className="flex items-center gap-2 py-1 underline decoration-dotted underline-offset-2"
    >
      <Icon d={PATHS.file} className="h-5 w-5 shrink-0" />
      <span className="min-w-0 break-all text-sm">
        {mediaFilename(item.localPath)}
      </span>
      <Icon d={PATHS.download} className="h-4 w-4 shrink-0" />
    </a>
  );
}

/* ---------- remark editor ---------- */

function RemarkEditor({
  bot,
  onDone,
}: {
  bot: Bot;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(bot.remark);
  const mutation = useMutation({
    mutationFn: (remark: string) => api.setRemark({ botId: bot.id, remark }),
    onSuccess: onDone,
  });
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(draft);
      }}
    >
      <label htmlFor="remark-input" className="sr-only">
        机器人备注
      </label>
      <input
        id="remark-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="给这个微信起个备注名"
        maxLength={60}
        autoFocus
        className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
      />
      <button
        type="submit"
        disabled={mutation.isPending}
        aria-label="保存备注"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-white disabled:opacity-50"
      >
        <Icon d={PATHS.check} />
      </button>
      <button
        type="button"
        onClick={onDone}
        aria-label="取消编辑备注"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-[var(--dim)]"
      >
        <Icon d={PATHS.x} />
      </button>
      {mutation.isError ? (
        <span className="text-xs text-red-500">保存失败，再试一次</span>
      ) : null}
    </form>
  );
}

/* ---------- shared bits ---------- */

function SyncButton({
  syncing,
  onSync,
}: {
  syncing: boolean;
  onSync: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSync}
      disabled={syncing}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white disabled:opacity-60"
    >
      <Icon
        d={PATHS.refresh}
        className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`}
      />
      同步
    </button>
  );
}

function BackButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-[var(--dim)]"
    >
      <Icon d={PATHS.chevronLeft} className="h-5 w-5" />
    </button>
  );
}

function StatusDot({ bot }: { bot: Bot }) {
  return (
    <>
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
          bot.lastError ? "bg-red-500" : "bg-[var(--accent)]"
        }`}
        aria-hidden="true"
      />
      <span className="shrink-0 text-xs text-[var(--dim)]">
        {bot.lastError ? "最近有报错" : "已绑定"}
      </span>
    </>
  );
}

/** The 「当前」 marker: deliberately NOT the accent green, so it reads as a
 *  status label rather than blending into the green UI chrome. */
function CurrentBadge() {
  return (
    <span className="shrink-0 rounded-full bg-[var(--current-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--current-text)]">
      当前
    </span>
  );
}

/** Red unread-count pill (WeChat-style). Renders nothing at zero. */
function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--unread)] px-1.5 text-[11px] font-semibold leading-none text-white"
      aria-label={`${count} 条未读`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/* ---------- the app ---------- */

type Screen = "bots" | "conversations" | "chat";

export function App() {
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<Screen>("bots");
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [editingRemark, setEditingRemark] = useState(false);
  const [search, setSearch] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  /* Send box + pause toggle (chat view only) */
  const [draft, setDraft] = useState("");
  const [footerError, setFooterError] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const optimisticRef = useRef<ChatMessage | null>(null);
  /* File attach (image/video/.silk): the picked file, its preview object
   * URL for the thumbnail, and the hidden file input the attach button
   * opens. The preview URL also lives in a ref so cleanup never reads a
   * stale render's value. */
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [attachPreview, setAttachPreview] = useState<string | null>(null);
  const attachPreviewRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function setPreview(url: string | null) {
    if (attachPreviewRef.current) {
      URL.revokeObjectURL(attachPreviewRef.current);
    }
    attachPreviewRef.current = url;
    setAttachPreview(url);
  }

  function clearAttachment() {
    setPreview(null);
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onFileSelected(file: File | undefined) {
    if (!file) return;
    const err = validateAttachment(file);
    if (err) {
      setFooterError(err);
      return;
    }
    // .silk magic is checked here (first 10 bytes) so a bad voice file is
    // rejected before the base64 upload; the server re-checks it anyway.
    const silkErr = await validateSilkMagic(file);
    if (silkErr) {
      setFooterError(silkErr);
      return;
    }
    setAttachedFile(file);
    setPreview(URL.createObjectURL(file));
    setFooterError(null);
    setSendNotice(null);
  }
  /* Unread tracking: `seenThrough` is how many messages of the open
   * conversation count as seen *this visit* — it drives the new-message
   * divider and the "start at the first new message" landing. The overview's
   * unreadCount (server-side, persisted) is lower or equal; seenThrough only
   * ever moves forward during a visit. */
  const [seenThrough, setSeenThrough] = useState(0);
  const seenThroughRef = useRef(0);
  /* Index of the first message that was new when this conversation was
   * opened; -1 when the resume point has been consumed (or there was none). */
  const [resumeIndex, setResumeIndex] = useState(-1);
  const resumeArmedRef = useRef(false);

  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.getOverview({}),
    refetchInterval: POLL_MS,
  });

  useEffect(() => {
    if (overview.data?.fetchedAt) {
      setLastSyncAt(new Date(overview.data.fetchedAt));
    }
  }, [overview.data?.fetchedAt]);

  const bots = overview.data?.bots ?? [];
  // Selection is by id, never by position: a binding added or removed later
  // just changes the lists; the open bot/conversation stays put as long as
  // it still exists, and falls back to a list screen if it went away.
  const bot: Bot | undefined = bots.find((b) => b.id === selectedBotId);
  const conversation: Conversation | undefined = bot?.conversations.find(
    (c) => c.id === selectedConvId,
  );

  const inChat = screen === "chat" && Boolean(bot && conversation);

  const messages = useQuery({
    queryKey: ["messages", bot?.id ?? "", conversation?.id ?? ""],
    queryFn: () =>
      api.getMessages({
        botId: bot?.id ?? "",
        conversationId: conversation?.id ?? "",
      }),
    enabled: inChat,
    refetchInterval: POLL_MS,
  });

  const msgs = useMemo(() => messages.data?.messages ?? [], [messages.data]);

  /* ---- pause state + send box ---- */
  const messagesKey = ["messages", bot?.id ?? "", conversation?.id ?? ""] as const;
  const pausedKey = ["paused", bot?.id ?? "", bot?.conversationSha ?? ""] as const;

  const pausedQuery = useQuery({
    queryKey: pausedKey,
    queryFn: () =>
      api.getPaused({
        botId8: bot?.id.slice(0, 8) ?? "",
        conversationSha: bot?.conversationSha ?? "",
      }),
    enabled: inChat,
    refetchInterval: POLL_MS,
  });
  const paused = pausedQuery.data?.paused ?? false;

  function removeOptimistic() {
    const opt = optimisticRef.current;
    if (!opt) return;
    optimisticRef.current = null;
    queryClient.setQueryData<MessagesData>(messagesKey, (old) =>
      old ? { ...old, messages: old.messages.filter((m) => m !== opt) } : old,
    );
  }

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      api.sendMessage({
        botId8: bot?.id.slice(0, 8) ?? "",
        conversationSha: bot?.conversationSha ?? "",
        text,
      }),
    onMutate: (text) => {
      // Show the message right away; the 8s poll (or the success refetch)
      // replaces it with the line the server wrote to the history file.
      const optimistic: ChatMessage = {
        ts: beijingNowIso(),
        role: "assistant",
        text,
      };
      optimisticRef.current = optimistic;
      queryClient.setQueryData<MessagesData>(messagesKey, (old) =>
        old ? { ...old, messages: [...old.messages, optimistic] } : old,
      );
    },
    onError: () => {
      removeOptimistic();
      setFooterError("发送失败，请再试一次");
    },
    onSuccess: (res) => {
      if (!res.ok) {
        removeOptimistic();
        setFooterError(res.error ?? "发送失败，请再试一次");
        return;
      }
      optimisticRef.current = null;
      setFooterError(null);
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  /* File send: the picked file goes up as base64 (the SDK's fileToBase64
   * shape) and the server saves it into this bot's media dir, calls the
   * CLI's send-media, and records the caption + media lines. The caption
   * is optimistically appended like a text send; the media line itself
   * appears on the success refetch (its server-side filename is only
   * known after the upload). A failed send keeps the attachment in place
   * so the user can retry. */
  const sendMediaMutation = useMutation({
    mutationFn: async (args: { file: File; caption: string }) => {
      const { dataBase64, mimeType } = await fileToBase64(args.file);
      return api.sendMedia({
        botId8: bot?.id.slice(0, 8) ?? "",
        conversationSha: bot?.conversationSha ?? "",
        filename: args.file.name,
        dataBase64,
        mimeType,
        caption: args.caption,
      });
    },
    onMutate: (args) => {
      if (args.caption.trim()) {
        const optimistic: ChatMessage = {
          ts: beijingNowIso(),
          role: "assistant",
          text: args.caption.trim(),
        };
        optimisticRef.current = optimistic;
        queryClient.setQueryData<MessagesData>(messagesKey, (old) =>
          old ? { ...old, messages: [...old.messages, optimistic] } : old,
        );
      }
    },
    onError: () => {
      removeOptimistic();
      setFooterError("发送失败，请再试一次");
    },
    onSuccess: (res) => {
      if (!res.ok) {
        removeOptimistic();
        setFooterError(res.error ?? "发送失败，请再试一次");
        return;
      }
      optimisticRef.current = null;
      setFooterError(null);
      setSendNotice(
        res.compressed
          ? `图片较大，已自动压缩后发送（${formatFileSize(res.originalBytes)} → ${formatFileSize(res.finalBytes)}）`
          : null,
      );
      clearAttachment();
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: (next: boolean) =>
      api.setPaused({
        botId8: bot?.id.slice(0, 8) ?? "",
        conversationSha: bot?.conversationSha ?? "",
        paused: next,
      }),
    onSuccess: (res) => {
      if (res.error) {
        setFooterError(res.error);
        return;
      }
      setFooterError(null);
      queryClient.setQueryData(pausedKey, {
        paused: res.paused,
        error: null,
      });
    },
    onError: () => {
      setFooterError("切换暂停状态失败，请再试一次");
    },
  });

  /* ---- unread bookkeeping ---- */
  const seenMutation = useMutation({
    mutationFn: (args: {
      botId: string;
      conversationId: string;
      seenCount: number;
    }) => api.markConversationSeen(args),
  });
  const seenMutationRef = useRef(seenMutation);
  seenMutationRef.current = seenMutation;

  const latestRef = useRef({ botId: "", conversationId: "", count: 0 });
  latestRef.current = {
    botId: bot?.id ?? "",
    conversationId: conversation?.id ?? "",
    count: msgs.length,
  };

  /** Mark everything up to message n of the open conversation as seen:
   *  advances the local position and persists it server-side. */
  function markSeenThrough(n: number) {
    if (n <= seenThroughRef.current) return;
    seenThroughRef.current = n;
    setSeenThrough(n);
    const { botId, conversationId } = latestRef.current;
    if (botId && conversationId) {
      seenMutationRef.current.mutate({ botId, conversationId, seenCount: n });
    }
  }

  /* While the user sits at the bottom of the open chat, anything that
   * arrives is on screen — count it as seen so the badges keep up. */
  useEffect(() => {
    /* While a resume jump to the first unread message is still armed, pause
     * marking seen: clearing the position early would wipe the new-message
     * divider and the unread badges before the user ever lands there. */
    if (resumeArmedRef.current) return;
    if (inChat && pinnedToBottom.current && msgs.length > 0) {
      markSeenThrough(msgs.length);
    }
    // markSeenThrough is stable enough via refs; msgs/inChat drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs.length, inChat]);

  /* The resume point is armed on open; once the messages have loaded, jump
   * to the first new message instead of the newest one. */
  useEffect(() => {
    if (!inChat || !resumeArmedRef.current || msgs.length === 0) return;
    if (resumeIndex < 0 || resumeIndex >= msgs.length) return;
    /* Disarm only once the landing point is really among the loaded
     * messages; disarming earlier (on a not-yet-loaded index) would lose
     * the jump and let mark-seen clear the unread state prematurely. */
    resumeArmedRef.current = false;
    pinnedToBottom.current = false;
    requestAnimationFrame(() => {
      msgRefs.current
        .get(resumeIndex)
        ?.scrollIntoView({ block: "start", behavior: "auto" });
    });
    // resumeIndex is captured at open time; msgs arriving arms the jump once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inChat, msgs.length, resumeIndex]);

  /* search within the open conversation only */
  const query = search.trim();
  const matchIndices = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    const out: number[] = [];
    msgs.forEach((m, i) => {
      if (visibleTextOf(m).toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }, [msgs, query]);

  useEffect(() => {
    setActiveMatch(0);
  }, [query, conversation?.id, bot?.id]);

  const activeMsgIndex =
    matchIndices.length > 0
      ? matchIndices[Math.min(activeMatch, matchIndices.length - 1)] ?? -1
      : -1;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const msgRefs = useRef(new Map<number, HTMLDivElement>());
  const pinnedToBottom = useRef(true);
  const contextKey = `${bot?.id ?? ""}/${conversation?.id ?? ""}`;
  const lastContext = useRef("");

  /* conversation switch: jump to the newest message — unless a resume
   * point (first unread message) is armed, which the resume effect owns */
  useEffect(() => {
    if (lastContext.current !== contextKey) {
      lastContext.current = contextKey;
      pinnedToBottom.current = true;
    }
    if (resumeArmedRef.current) return;
    if (pinnedToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [msgs, contextKey]);

  /* search navigation: center the active match */
  useEffect(() => {
    if (activeMsgIndex < 0) return;
    pinnedToBottom.current = false;
    msgRefs.current
      .get(activeMsgIndex)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeMsgIndex, query]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    pinnedToBottom.current = atBottom;
    /* Reaching the newest message means everything above it has been on
     * screen: clear the unread position for this conversation. */
    if (atBottom && latestRef.current.count > 0) {
      markSeenThrough(latestRef.current.count);
    }
  }

  async function syncNow() {
    setSyncing(true);
    try {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["overview"] }),
        queryClient.refetchQueries({ queryKey: ["messages"] }),
      ]);
      setLastSyncAt(new Date());
    } finally {
      setSyncing(false);
    }
  }

  function gotoMatch(delta: number) {
    if (matchIndices.length === 0) return;
    setActiveMatch(
      (cur) => (cur + delta + matchIndices.length) % matchIndices.length,
    );
  }

  function openBot(b: Bot) {
    setSelectedBotId(b.id);
    setSelectedConvId(null);
    setEditingRemark(false);
    setScreen("conversations");
  }

  function openConversation(c: Conversation) {
    setSelectedConvId(c.id);
    setSearch("");
    setActiveMatch(0);
    setDraft("");
    clearAttachment();
    setFooterError(null);
    setSendNotice(null);
    /* Land on the first message the user has not seen yet (when there is
     * one); with nothing unread the chat opens at the newest message. */
    const seen = Math.max(0, c.messageCount - c.unreadCount);
    seenThroughRef.current = seen;
    setSeenThrough(seen);
    if (c.unreadCount > 0) {
      setResumeIndex(seen);
      resumeArmedRef.current = true;
    } else {
      setResumeIndex(-1);
      resumeArmedRef.current = false;
    }
    setScreen("chat");
  }

  function jumpToFirstUnread() {
    if (resumeIndex < 0) return;
    pinnedToBottom.current = false;
    msgRefs.current
      .get(resumeIndex)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  const syncNote = lastSyncAt
    ? `上次同步 ${clockLabel(lastSyncAt)}，页面每 8 秒自动同步一次`
    : "页面每 8 秒自动同步一次";

  /* ================= level 1: pick a bot ================= */
  if (screen === "bots") {
    return (
      <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
        <header className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 pb-3 pt-safe">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 pt-3">
            <div>
              <h1 className="text-lg font-semibold leading-snug">选择机器人</h1>
              <p className="mt-0.5 text-xs text-[var(--dim)]">{syncNote}</p>
            </div>
            <SyncButton syncing={syncing} onSync={syncNow} />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto w-full max-w-3xl">
            {overview.isPending ? (
              <p className="py-16 text-center text-sm text-[var(--dim)]">
                正在读取绑定…
              </p>
            ) : overview.isError ? (
              <div className="py-16 text-center">
                <p className="text-sm text-red-500">读取绑定失败</p>
                <button
                  type="button"
                  onClick={() => overview.refetch()}
                  className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm"
                >
                  重试
                </button>
              </div>
            ) : !overview.data?.bindingsFound ? (
              <p className="py-16 text-center text-sm text-[var(--dim)]">
                没读到机器人绑定记录（bindings.json 不存在或无法解析）。
              </p>
            ) : bots.length === 0 ? (
              <p className="py-16 text-center text-sm text-[var(--dim)]">
                当前没有绑定的微信机器人。新绑定的机器人会自动出现在这里。
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                {bots.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => openBot(b)}
                      className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
                      aria-label={`打开机器人 ${b.remark || b.label} 的对话列表`}
                    >
                      <SideAvatar side="muse" size={44} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-medium">
                            {b.remark || b.label}
                          </span>
                          <StatusDot bot={b} />
                        </span>
                        <span
                          className="mt-0.5 block break-all text-xs text-[var(--dim)] sm:truncate"
                          title={`${b.displayName}${b.platformBotId ? ` · ${b.platformBotId}` : ""}${b.remark && b.remark !== b.label ? ` · 原名 ${b.label}` : ""}`}
                        >
                          {b.displayName}
                          {b.platformBotId ? ` · ${b.platformBotId}` : ""}
                          {b.remark && b.remark !== b.label
                            ? ` · 原名 ${b.label}`
                            : ""}
                        </span>
                        {b.lastError ? (
                          <span className="mt-0.5 block truncate text-xs text-red-500">
                            {b.lastError}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--dim)]">
                        <UnreadBadge count={b.unreadTotal} />
                        {b.conversations.length} 个对话
                        <Icon d={PATHS.chevronRight} className="h-4 w-4" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ===== deep screens need the selected bot to still exist ===== */
  if (!bot) {
    return (
      <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4">
          <p className="text-sm text-[var(--dim)]">
            {overview.isPending
              ? "正在读取绑定…"
              : "这个机器人不在绑定列表里了（可能已解绑）。"}
          </p>
          <button
            type="button"
            onClick={() => setScreen("bots")}
            className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm"
          >
            返回机器人列表
          </button>
        </div>
      </div>
    );
  }

  /* ================= level 2: pick a conversation ================= */
  if (screen === "conversations") {
    return (
      <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
        <header className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 pb-3 pt-safe">
          <div className="mx-auto w-full max-w-3xl pt-3">
            <div className="flex items-start gap-2">
              <BackButton
                label="返回机器人列表"
                onClick={() => setScreen("bots")}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-lg font-semibold leading-snug">
                    {bot.remark || bot.label}
                  </h1>
                  <StatusDot bot={bot} />
                </div>
                <p
                  className="mt-0.5 break-all text-xs text-[var(--dim)] sm:truncate"
                  title={`${bot.displayName}${bot.platformBotId ? ` · ${bot.platformBotId}` : ""}${bot.remark && bot.remark !== bot.label ? ` · 原名 ${bot.label}` : ""}`}
                >
                  {bot.displayName}
                  {bot.platformBotId ? ` · ${bot.platformBotId}` : ""}
                  {bot.remark && bot.remark !== bot.label
                    ? ` · 原名 ${bot.label}`
                    : ""}
                </p>
                {bot.lastError ? (
                  <p className="mt-0.5 truncate text-xs text-red-500">
                    {bot.lastError}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditingRemark((v) => !v)}
                  aria-label="编辑备注"
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)] text-[var(--dim)]"
                >
                  <Icon d={PATHS.pencil} />
                </button>
                <SyncButton syncing={syncing} onSync={syncNow} />
              </div>
            </div>
            {editingRemark ? (
              <div className="pt-2">
                <RemarkEditor
                  bot={bot}
                  onDone={() => setEditingRemark(false)}
                />
              </div>
            ) : null}
            <p className="pt-1.5 text-xs text-[var(--dim)]">{syncNote}</p>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto w-full max-w-3xl">
            <h2 className="pb-2 text-sm font-medium text-[var(--dim)]">
              选择对话
            </h2>
            {bot.conversations.length === 0 ? (
              <p className="py-16 text-center text-sm text-[var(--dim)]">
                这个机器人还没有对话记录。新建的对话会自动出现在这里。
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                {bot.conversations.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => openConversation(c)}
                      className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
                      aria-label={`打开对话 ${c.label}`}
                    >
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--chip)] text-[var(--dim)]">
                        <Icon d={PATHS.message} className="h-5 w-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-medium">
                            {c.label}
                          </span>
                          {c.status === "current" ? <CurrentBadge /> : null}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-[var(--dim)]">
                          {c.messageCount} 条消息
                          {c.unreadCount > 0 ? (
                            <span className="font-medium text-[var(--unread)]">
                              {" "}
                              · {c.unreadCount} 条未读
                            </span>
                          ) : null}
                          {c.createdAt
                            ? ` · 建于 ${dateLabel(c.createdAt)}`
                            : ""}
                          {c.status !== "current" ? " · 已归档" : ""}
                        </span>
                      </span>
                      <UnreadBadge count={c.unreadCount} />
                      <Icon
                        d={PATHS.chevronRight}
                        className="h-4 w-4 shrink-0 text-[var(--dim)]"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ================= level 3: the chat itself ================= */
  if (!conversation) {
    return (
      <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4">
          <p className="text-sm text-[var(--dim)]">这个对话不在列表里了。</p>
          <button
            type="button"
            onClick={() => setScreen("conversations")}
            className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm"
          >
            返回对话列表
          </button>
        </div>
      </div>
    );
  }

  const remainingUnread = Math.max(0, msgs.length - seenThrough);
  /* Either send path in flight disables the whole send box. */
  const sending = sendMutation.isPending || sendMediaMutation.isPending;

  return (
    <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
      {/* ----- chat header ----- */}
      <header className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 pb-3 pt-safe">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 pt-3">
          <BackButton
            label="返回对话列表"
            onClick={() => setScreen("conversations")}
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold leading-snug">
              {conversation.label}
            </h1>
            <p className="truncate text-xs text-[var(--dim)]">
              {bot.remark || bot.label} · {conversation.messageCount} 条
              {conversation.status === "current" ? " · 当前对话" : " · 已归档"}
            </p>
          </div>
          {resumeIndex >= 0 && remainingUnread > 0 ? (
            <button
              type="button"
              onClick={jumpToFirstUnread}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-[var(--unread)] px-3 text-sm font-medium text-white"
            >
              {remainingUnread} 条新消息
            </button>
          ) : null}
          <SyncButton syncing={syncing} onSync={syncNow} />
        </div>
      </header>

      {/* ----- search bar (scoped to the open conversation) ----- */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--dim)]">
              <Icon d={PATHS.search} className="h-4 w-4" />
            </span>
            <label htmlFor="chat-search" className="sr-only">
              搜索当前对话
            </label>
            <input
              id="chat-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索当前对话"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--chip)] py-2 pl-9 pr-8 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="清除搜索"
                className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-[var(--dim)]"
              >
                <Icon d={PATHS.x} className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          {query ? (
            <>
              <span className="shrink-0 text-xs text-[var(--dim)]">
                {matchIndices.length === 0
                  ? "无结果"
                  : `${Math.min(activeMatch + 1, matchIndices.length)}/${matchIndices.length}`}
              </span>
              <button
                type="button"
                onClick={() => gotoMatch(-1)}
                disabled={matchIndices.length === 0}
                aria-label="上一个匹配"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-[var(--dim)] disabled:opacity-40"
              >
                <Icon d={PATHS.chevronUp} />
              </button>
              <button
                type="button"
                onClick={() => gotoMatch(1)}
                disabled={matchIndices.length === 0}
                aria-label="下一个匹配"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-[var(--dim)] disabled:opacity-40"
              >
                <Icon d={PATHS.chevronDown} />
              </button>
            </>
          ) : null}
        </div>
      </div>

      {/* ----- chat stream ----- */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <div className="mx-auto w-full max-w-3xl">
          {messages.isPending ? (
            <p className="py-16 text-center text-sm text-[var(--dim)]">
              正在读取聊天记录…
            </p>
          ) : messages.isError ? (
            <div className="py-16 text-center">
              <p className="text-sm text-red-500">聊天记录读取失败</p>
              <button
                type="button"
                onClick={() => messages.refetch()}
                className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm"
              >
                重试
              </button>
            </div>
          ) : messages.data && !messages.data.found ? (
            <p className="py-16 text-center text-sm text-[var(--dim)]">
              这个对话的记录文件找不到了。
            </p>
          ) : msgs.length === 0 ? (
            <p className="py-16 text-center text-sm text-[var(--dim)]">
              这个对话还没有消息。
            </p>
          ) : (
            msgs.map((m, i) => {
              const d = parseTs(m.ts);
              const prev = i > 0 ? msgs[i - 1] : undefined;
              const prevD = prev ? parseTs(prev.ts) : null;
              const showTime =
                !d ||
                !prevD ||
                dayKey(d) !== dayKey(prevD) ||
                d.getTime() - prevD.getTime() > 5 * 60 * 1000;
              const isUser = m.role === "user";
              const isActive = i === activeMsgIndex;
              return (
                <div key={i}>
                  {showTime && d ? (
                    <p className="py-3 text-center text-xs text-[var(--dim)]">
                      {dayLabel(d)}
                    </p>
                  ) : null}
                  {i === resumeIndex ? (
                    <div
                      className="flex items-center gap-3 pb-3 pt-1"
                      role="separator"
                      aria-label="以下为新消息"
                    >
                      <span className="h-px flex-1 bg-[var(--unread)] opacity-50" />
                      <span className="text-xs font-medium text-[var(--unread)]">
                        以下为新消息
                      </span>
                      <span className="h-px flex-1 bg-[var(--unread)] opacity-50" />
                    </div>
                  ) : null}
                  <div
                    ref={(el) => {
                      if (el) msgRefs.current.set(i, el);
                      else msgRefs.current.delete(i);
                    }}
                    className={`flex items-start gap-2 pb-3 ${
                      isUser ? "flex-row-reverse" : "flex-row"
                    }`}
                  >
                    <SideAvatar side={isUser ? "wechat" : "muse"} />
                    <div
                      className={`max-w-[72%] whitespace-pre-wrap break-words px-3 py-2 text-[15px] leading-relaxed shadow-sm ${
                        isUser
                          ? "rounded-lg rounded-tr-sm bg-[var(--bubble-user)] text-[var(--bubble-user-text)]"
                          : "rounded-lg rounded-tl-sm bg-[var(--surface)] text-[var(--text)]"
                      } ${isActive ? "ring-2 ring-amber-400 ring-offset-1" : ""}`}
                    >
                      {m.media && m.media.length > 0 ? (
                        <div className={hidesPlaceholderText(m) ? "" : "pb-1.5"}>
                          {m.media.map((item, k) => (
                            <MediaView key={k} item={item} />
                          ))}
                        </div>
                      ) : null}
                      {hidesPlaceholderText(m) ? null : (
                        <HighlightedText
                          text={m.text}
                          query={query}
                          isActiveMatch={isActive}
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ----- send box + pause toggle ----- */}
      <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3 pb-safe">
        <div className="mx-auto w-full max-w-3xl">
          {paused ? (
            <p className="mb-2 rounded-md bg-amber-100 px-3 py-1.5 text-xs text-amber-800">
              自动回复已暂停：朋友发来的消息只会记录，不会自动回。你可以在这里手动回。
            </p>
          ) : null}
          {attachedFile ? (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--chip)] px-2 py-1.5">
              {attachPreview && attachedFile.type.startsWith("image/") ? (
                <img
                  src={attachPreview}
                  alt="待发送的图片预览"
                  className="h-10 w-10 shrink-0 rounded object-cover"
                />
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-[var(--surface)] text-[var(--dim)]">
                  <Icon d={PATHS.file} className="h-5 w-5" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--text)]">
                {attachedFile.name} · {formatFileSize(attachedFile.size)}
              </span>
              <button
                type="button"
                onClick={clearAttachment}
                disabled={sending}
                aria-label="移除附件"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--dim)] disabled:opacity-50"
              >
                <Icon d={PATHS.x} className="h-4 w-4" />
              </button>
            </div>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (sending) return;
              const caption = draft.trim();
              if (attachedFile) {
                setDraft("");
                sendMediaMutation.mutate({ file: attachedFile, caption });
                return;
              }
              if (!caption) return;
              setDraft("");
              sendMutation.mutate(caption);
            }}
            className="flex items-center gap-2"
          >
            <button
              type="button"
              onClick={() => pauseMutation.mutate(!paused)}
              disabled={pauseMutation.isPending || pausedQuery.isPending}
              aria-pressed={paused}
              title={paused ? "恢复自动回复" : "暂停自动回复"}
              className={`h-10 shrink-0 rounded-md px-3 text-sm font-medium disabled:opacity-50 ${
                paused
                  ? "bg-[var(--unread)] text-white"
                  : "border border-[var(--border)] text-[var(--dim)]"
              }`}
            >
              {paused ? "已暂停，点击恢复" : "暂停自动回复"}
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              aria-label="添加图片或视频"
              title="添加图片或视频"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-[var(--dim)] disabled:opacity-50"
            >
              <Icon d={PATHS.paperclip} className="h-5 w-5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,.silk"
              aria-label="选择要发送的图片或视频"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                onFileSelected(f);
              }}
            />
            <label htmlFor="send-input" className="sr-only">
              发消息
            </label>
            <input
              id="send-input"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (footerError) setFooterError(null);
              }}
              placeholder={
                attachedFile
                  ? "给这个文件加一句说明（可选，先发过去）…"
                  : paused
                    ? "手动回复（自动回复已暂停）…"
                    : "替机器人回一句话…"
              }
              maxLength={2000}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--chip)] px-3 py-2.5 text-[15px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <button
              type="submit"
              disabled={(!draft.trim() && !attachedFile) || sending}
              className="h-10 shrink-0 rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              {sending ? "发送中…" : "发送"}
            </button>
          </form>
          {sendNotice ? (
            <p className="pt-2 text-xs text-[var(--current-text)]">{sendNotice}</p>
          ) : null}
          {footerError ? (
            <p className="pt-2 text-xs text-red-500">{footerError}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
