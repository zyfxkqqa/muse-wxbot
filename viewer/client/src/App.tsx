import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
};

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

/* ---------- time formatting ---------- */

function parseTs(ts: string): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(d: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86400000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
  if (diffDays === 0) return hm;
  if (diffDays === 1) return `昨天 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function clockLabel(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

function dateLabel(ts: string): string {
  const d = parseTs(ts);
  if (!d) return "";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
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
    resumeArmedRef.current = false;
    if (resumeIndex < 0 || resumeIndex >= msgs.length) return;
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
      if (m.text.toLowerCase().includes(q)) out.push(i);
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
                        <span className="mt-0.5 block truncate text-xs text-[var(--dim)]">
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
                <p className="mt-0.5 truncate text-xs text-[var(--dim)]">
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
                      <HighlightedText
                        text={m.text}
                        query={query}
                        isActiveMatch={isActive}
                      />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
