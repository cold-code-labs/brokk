"use client";

// ─────────────────────────────────────────────────────────────────────────────
// SINDRI — the interactive chat agent, as a workbench (Lovable/v0 shape):
//   • Top = a horizontal strip of session tabs + "Novo chat". Project is set by
//     the global AMBIENTE switcher (sidebar), not here.
//   • Left = the conversation: editable title, model/effort, live stats, thread
//     and composer.
//   • Right = a LIVE preview sandbox: `next dev` (HMR) running in this session's
//     own checkout, so Sindri's edits hot-reload in the iframe (and on the public
//     <app>-sindri-<id8>.preview.coldcodelabs.com) as it works.
// Turns run server-side detached, so closing the tab doesn't stop Sindri.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { Streamdown } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Banner, Button } from "@cold-code-labs/yggdrasil-react";
import {
  Plus,
  Send,
  Square,
  Hammer,
  Trash2,
  GitBranch,
  Check,
  MessageSquare,
  Zap,
  Copy,
  Brain,
  ArrowDown,
  ChevronDown,
  Wrench,
  FileEdit,
  FileText,
  TerminalSquare,
  ListTodo,
  GitPullRequest,
  Monitor,
  Smartphone,
  RotateCw,
  Database,
  Eye,
  Code2,
  KeyRound,
  ExternalLink,
  PanelRightClose,
  PanelRightOpen,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useProject } from "../lib/project-context";
import PublishControls from "./PublishControls";
import { brokk } from "../lib/api";
import {
  attach,
  chat,
  sendMessage,
  type Block,
  type ChatMessage,
  type ChatSessionWithStats,
  type Preview,
  type AgentEvent,
} from "../lib/chat";
import { STATUS_COLOR, t as theme } from "../lib/theme";
import { StudioPanel } from "./StudioPanel";
import { FileViewer } from "./FileViewer";

// Full model choice. The subscription-seat gate that used to 429 Sonnet/Opus is
// fixed at the gateway (Ratatoskr shapes the Claude Code system marker so the
// premium tiers serve reliably), so all three are selectable. Default is Sonnet;
// Opus for hard work, Haiku for cheap/fast turns.
const MODELS = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
];

// Reasoning effort → extended-thinking budget (backend: low=off, medium, high).
const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "Deep" },
];

// Turn engine — fixed at session creation (the engine owns the continuity):
// afl = the native lean loop (default), cli = the genuine Claude Code CLI lane.
const ENGINES = [
  { id: "afl", label: "Sindri" },
  { id: "cli", label: "Claude Code" },
];

// Split (chat fraction) — persisted per-browser, so the balance you set survives
// reloads and session switches. Default is an even 50/50 so the conversation gets
// real width; snap points give a magnetic 50/60/68 without pixel-hunting, and
// double-clicking the gutter restores the default.
const SPLIT_KEY = "sindri-split";
const SPLIT_DEFAULT = 0.46;
const SPLIT_MIN = 0.3;
const SPLIT_MAX = 0.72;
const SPLIT_SNAP = [0.4, 0.5, 0.6];
function snapSplit(r: number): number {
  const clamped = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, r));
  for (const p of SPLIT_SNAP) if (Math.abs(clamped - p) < 0.018) return p;
  return clamped;
}
// The preview never drags narrower than a phone: at that edge the drag stops and
// the viewport flips to mobile (dragging back out flips it to desktop again).
const PREVIEW_MOBILE_PX = 430;

// ── small formatters ─────────────────────────────────────────────────────────
function fmtTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function relTime(iso?: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} d`;
  return new Date(iso).toLocaleDateString("en-US", { day: "2-digit", month: "short" });
}

function sessionTime(s: ChatSessionWithStats): string {
  return s.stats.lastMessageAt || s.updatedAt;
}

// A tool_use whose name implies a file mutation → the app may have a renderable
// change worth booting the preview for (the lazy trigger).
const EDIT_TOOL = /write|edit|str_replace|create|apply|patch/i;

export default function Chat() {
  // Project selection is GLOBAL now (the sidebar AMBIENTE switcher) — Sindri reads
  // the same context, so the active environment drives which project Sindri works.
  const { projects, currentId: projectId } = useProject();
  // Projeto mobile (runtime Expo/Metro): o preview é a app RN-web num viewport
  // de celular — visualização EXCLUSIVA mobile (presets de aparelho, sem drag).
  const mobileOnly = projects.find((p) => p.id === projectId)?.runtime?.id === "expo";
  const [model, setModel] = useState("sonnet");
  const [effort, setEffort] = useState("medium");
  const [engine, setEngine] = useState("afl");
  const [sessions, setSessions] = useState<ChatSessionWithStats[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [liveThinking, setLiveThinking] = useState("");
  const [phase, setPhase] = useState("");
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [blankDraft, setBlankDraft] = useState("");
  const [blankBusy, setBlankBusy] = useState(false);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  // Right-pane preview can be collapsed to give the chat full width.
  const [previewOpen, setPreviewOpen] = useState(true);
  // Zen/focus: collapse the chat so the preview goes full-bleed (demo mode).
  const [chatCollapsed, setChatCollapsed] = useState(false);
  // Draggable split ratio (chat fraction) when both panes are open.
  const [split, setSplit] = useState(SPLIT_DEFAULT);
  const [dragging, setDragging] = useState(false);
  // Preview viewport (lifted here so the gutter drag can flip it to mobile at the
  // narrow edge); the preview's own toggles also drive it.
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const liveSeqRef = useRef(-1); // highest seq we've persisted into messages
  // Projects we're already minting a first chat for — guards against a double
  // create from React Strict-Mode's mount/remount or a fast environment re-select.
  const creatingRef = useRef<Set<string>>(new Set());

  // ── loaders ─────────────────────────────────────────────────────────────────
  // On environment change: load its sessions and make sure one is ready to use —
  // open the newest, or mint the very first chat when the project is empty. So
  // selecting an environment always lands you in a usable chat (never a dead end).
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    (async () => {
      const list = await chat.listSessions(projectId).catch(() => null);
      if (!active) return;
      if (!list) {
        setSessions([]);
        return;
      }
      setSessions(list);
      if (list.length > 0) {
        const newest = [...list].sort(
          (a, b) => +new Date(sessionTime(b)) - +new Date(sessionTime(a)),
        )[0]!;
        void openSession(newest.id);
        return;
      }
      // Empty project → create the first chat (once).
      if (creatingRef.current.has(projectId)) return;
      creatingRef.current.add(projectId);
      const s = await chat.createSession({ projectId, model, effort, engine }).catch(() => null);
      creatingRef.current.delete(projectId);
      if (!active || !s) return;
      const withStats: ChatSessionWithStats = {
        ...s,
        stats: { messages: 0, tokensIn: 0, tokensOut: 0, lastMessageAt: null },
      };
      setSessions([withStats]);
      void openSession(s.id);
    })();
    return () => {
      active = false;
    };
    // openSession/model/effort are intentionally not deps: this fires on
    // environment change, using whatever model/effort are current at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Restore the persisted split once on mount (client-only; the body isn't
  // rendered until a session loads, so this lands before the grid paints).
  useEffect(() => {
    try {
      const v = parseFloat(localStorage.getItem(SPLIT_KEY) ?? "");
      if (v >= SPLIT_MIN && v <= SPLIT_MAX) setSplit(v);
    } catch {
      /* private mode / no storage — keep the default */
    }
  }, []);

  const upsert = useCallback((m: { seq: number; role: ChatMessage["role"]; blocks: Block[] }) => {
    if (m.seq > liveSeqRef.current) liveSeqRef.current = m.seq;
    setMessages((prev) => {
      const i = prev.findIndex((x) => x.seq === m.seq);
      const row = { id: `seq-${m.seq}`, sessionId, seq: m.seq, role: m.role, blocks: m.blocks, meta: null, createdAt: "" };
      if (i >= 0) {
        const c = [...prev];
        c[i] = row;
        return c;
      }
      return [...prev, row].sort((a, b) => a.seq - b.seq);
    });
  }, [sessionId]);

  const handleEvent = useCallback(
    (e: AgentEvent) => {
      switch (e.type) {
        case "text_delta":
          setLiveText((t) => t + e.text);
          break;
        case "thinking_delta":
          setLiveThinking((t) => t + e.text);
          break;
        case "message":
          upsert(e);
          // An assistant message has landed in the transcript — the live
          // scratchpad (streaming text + reasoning) is now redundant.
          if (e.role === "assistant") {
            setLiveText("");
            setLiveThinking("");
          }
          break;
        case "status":
          setPhase(e.phase === "round" ? "thinking" : e.phase);
          break;
        case "tool_use":
          setPhase(`tool: ${e.name}`);
          break;
        case "tool_result":
          setPhase("thinking");
          break;
        case "title":
          setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title: e.title } : s)));
          break;
        case "done":
        case "error":
          if (e.type === "error") setError(e.message);
          setRunning(false);
          setPhase("");
          setLiveText("");
          setLiveThinking("");
          // refresh stats for the session that just finished a turn
          if (projectId) chat.listSessions(projectId).then(setSessions).catch(() => {});
          break;
        default:
          break;
      }
    },
    [upsert, sessionId, projectId],
  );

  async function openSession(id: string) {
    abortRef.current?.abort();
    setSessionId(id);
    setMessages([]);
    setLiveText("");
    setLiveThinking("");
    setError("");
    setRenaming(false);
    liveSeqRef.current = -1;
    const { session, messages: msgs, running: live } = await chat.getSession(id);
    // Reflect the session's saved model + effort (all tiers are selectable now).
    setModel(MODELS.some((m) => m.id === session.model) ? session.model : "sonnet");
    setEffort(session.effort && EFFORTS.some((e) => e.id === session.effort) ? session.effort : "medium");
    setEngine(session.engine === "cli" ? "cli" : "afl");
    setMessages(msgs);
    liveSeqRef.current = msgs.length ? msgs[msgs.length - 1]!.seq : -1;
    if (live) {
      setRunning(true);
      const ac = new AbortController();
      abortRef.current = ac;
      attach(id, handleEvent, ac.signal).catch(() => setRunning(false));
    }
  }

  async function newChat() {
    if (!projectId) return;
    setError("");
    const s = await chat.createSession({ projectId, model, effort, engine });
    const withStats: ChatSessionWithStats = {
      ...s,
      stats: { messages: 0, tokensIn: 0, tokensOut: 0, lastMessageAt: null },
    };
    setSessions((prev) => [withStats, ...prev]);
    await openSession(s.id);
    return s.id;
  }

  async function send(sidOverride?: string, textOverride?: string) {
    const sid = sidOverride ?? sessionId;
    const text = (textOverride ?? input).trim();
    if (!text || !sid || running) return;
    setInput("");
    setError("");
    setLiveText("");
    setLiveThinking("");
    setRunning(true);
    setPhase("starting");
    // optimistic user bubble at the next seq
    upsert({ seq: liveSeqRef.current + 1, role: "user", blocks: [{ type: "text", text }] });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await sendMessage(sid, text, handleEvent, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) setError(String(e));
      setRunning(false);
    }
  }

  async function stop() {
    if (!sessionId) return;
    await chat.stop(sessionId).catch(() => {});
    setRunning(false);
    setPhase("");
  }

  async function removeSession(id: string, ev: React.MouseEvent) {
    ev.stopPropagation();
    const name = sessions.find((s) => s.id === id)?.title;
    if (!confirm(`This deletes ${name ? `"${name}"` : "the session"} and its transcript. Delete?`)) return;
    await chat.deleteSession(id).catch(() => {});
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (sessionId === id) {
      setSessionId("");
      setMessages([]);
    }
  }

  async function saveTitle() {
    const t = titleDraft.trim();
    setRenaming(false);
    if (!sessionId || !t || t === currentSession?.title) return;
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title: t } : s)));
    await chat.patchSession(sessionId, { title: t }).catch(() => {});
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  // Drag the gutter between chat and preview to re-balance the split. Clamped so
  // neither pane ever collapses by accident (use the zen/hide toggles for that),
  // snapped to the 42/50/60 marks, and persisted on release.
  function startDrag(e: React.PointerEvent) {
    e.preventDefault();
    const el = bodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let last = split;
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      let r = snapSplit((ev.clientX - rect.left) / rect.width);
      // Cap the chat so the preview never gets narrower than a phone.
      const maxSplit = Math.min(SPLIT_MAX, 1 - PREVIEW_MOBILE_PX / rect.width);
      if (r > maxSplit) r = maxSplit;
      last = r;
      setSplit(r);
      // Flip the viewport to mobile once the preview is phone-narrow, back to
      // desktop as it widens again.
      const previewPx = (1 - r) * rect.width;
      setDevice(previewPx <= PREVIEW_MOBILE_PX + 60 ? "mobile" : "desktop");
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      setDragging(false);
      try {
        localStorage.setItem(SPLIT_KEY, String(last));
      } catch {
        /* no storage — the in-session split still holds */
      }
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Double-click the gutter → restore the default balance.
  function resetSplit() {
    setSplit(SPLIT_DEFAULT);
    try {
      localStorage.setItem(SPLIT_KEY, String(SPLIT_DEFAULT));
    } catch {
      /* no storage */
    }
  }

  // tool_use_id → result, for inline rendering.
  const results = useMemo(() => {
    const m = new Map<string, Block & { type: "tool_result" }>();
    for (const msg of messages)
      for (const b of msg.blocks) if (b.type === "tool_result") m.set(b.tool_use_id, b);
    return m;
  }, [messages]);

  const currentProject = projects.find((p) => p.id === projectId);
  const currentSession = sessions.find((s) => s.id === sessionId);

  // Sessions newest-first for the top tab strip.
  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => +new Date(sessionTime(b)) - +new Date(sessionTime(a))),
    [sessions],
  );

  // Lazy preview trigger: has Sindri made a file-mutating tool call this session?
  const sawEdit = useMemo(
    () =>
      messages.some((m) =>
        m.blocks.some((b) => b.type === "tool_use" && EDIT_TOOL.test(b.name)),
      ),
    [messages],
  );

  // Token usage for the open session (shown in the preview header): aggregate
  // from loaded messages, falling back to the rail's stored aggregate.
  const tokens = useMemo(() => {
    let tin = 0;
    let tout = 0;
    for (const m of messages) {
      const u = (m.meta as { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } } | null)?.usage;
      if (u) {
        tin += (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0);
        tout += u.outputTokens ?? 0;
      }
    }
    if (!tin && !tout && currentSession) {
      tin = currentSession.stats.tokensIn;
      tout = currentSession.stats.tokensOut;
    }
    return { tin, tout };
  }, [messages, currentSession]);

  return (
    <main className="sindri">
      {error ? (
        <Banner tone="err" onClick={() => setError("")} style={{ cursor: "pointer" }}>
          {error}
        </Banner>
      ) : null}

      {/* ── body: chat | live preview ── */}
      {!sessionId ? (
        <div className="sindri-body is-blank">
          <div className="sindri-blank">
            <div className="sindri-blank-mark">
              <Hammer size={30} strokeWidth={1.4} />
            </div>
            <h3>{currentProject ? `At the anvil with ${currentProject.name}` : "Pick an environment"}</h3>
            <p>
              Sindri clones the repo, works a branch of its own, and boots the live preview
              beside the chat. Describe the first task to light the forge.
            </p>
            <form
              className="sindri-blank-bar"
              onSubmit={(e) => {
                e.preventDefault();
                const text = blankDraft.trim();
                if (!text || !projectId || blankBusy) return;
                setBlankBusy(true);
                void (async () => {
                  try {
                    const sid = await newChat();
                    if (sid) await send(sid, text);
                    setBlankDraft("");
                  } finally {
                    setBlankBusy(false);
                  }
                })();
              }}
            >
              <input
                value={blankDraft}
                onChange={(e) => setBlankDraft(e.target.value)}
                placeholder={currentProject ? `What should Sindri forge in ${currentProject.name}?` : "Pick a project first"}
                disabled={!projectId || blankBusy}
                aria-label="First task"
              />
              <button type="submit" disabled={!projectId || blankBusy || !blankDraft.trim()}>
                {blankBusy ? "Lighting…" : "Start"}
              </button>
            </form>
            <button type="button" className="sindri-blank-alt" onClick={() => void newChat()} disabled={!projectId || blankBusy}>
              or open an empty session
            </button>
          </div>
        </div>
      ) : (
        <div
          ref={bodyRef}
          className={`sindri-body ${!previewOpen ? "is-solo" : ""} ${chatCollapsed ? "is-zen" : ""}`}
          style={
            previewOpen && !chatCollapsed
              ? { gridTemplateColumns: `minmax(0, ${split}fr) 12px minmax(0, ${1 - split}fr)` }
              : undefined
          }
        >
          {/* ── chat column ── */}
          {!chatCollapsed ? (
          <section className="sindri-chat">
            <>
              {/* session header = the tab bar: new-chat + horizontally-scrolling
                  session chips (folded up from the old top strip). The active chip
                  renames on double-click; the preview restores here when hidden. */}
              <header className="sindri-head">
                <Button
                  variant="default"
                  onClick={newChat}
                  disabled={!projectId}
                  className="sindri-tab-new"
                  title="New chat"
                  aria-label="New chat"
                >
                  <Plus size={16} />
                </Button>
                <div className="sindri-tabs-scroll">
                  {sortedSessions.length === 0 ? (
                    <span className="sindri-tabs-empty">
                      {currentProject ? `No sessions in ${currentProject.name}.` : "Pick an environment."}
                    </span>
                  ) : (
                    sortedSessions.map((s) => {
                      const active = s.id === sessionId;
                      return (
                        <div
                          key={s.id}
                          className={`sindri-tab ${active ? "is-active" : ""}`}
                          onClick={() => {
                            if (!active) void openSession(s.id);
                          }}
                          onDoubleClick={() => {
                            if (active) {
                              setTitleDraft(s.title);
                              setRenaming(true);
                            }
                          }}
                          title={`${s.title} · ${relTime(sessionTime(s))}`}
                        >
                          {s.turnState === "running" ? (
                            <span className="sindri-dot" />
                          ) : (
                            <MessageSquare size={12} className="sindri-tab-icon" />
                          )}
                          {renaming && active ? (
                            <input
                              className="sindri-tab-rename"
                              autoFocus
                              value={titleDraft}
                              onChange={(e) => setTitleDraft(e.target.value)}
                              onBlur={saveTitle}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveTitle();
                                if (e.key === "Escape") setRenaming(false);
                              }}
                            />
                          ) : (
                            <span className="sindri-tab-title">{s.title}</span>
                          )}
                          <span
                            className="sindri-tab-del"
                            title="Delete session"
                            onClick={(e) => removeSession(s.id, e)}
                          >
                            <Trash2 size={12} />
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
                {!previewOpen ? (
                  <button
                    type="button"
                    className="sindri-preview-toggle"
                    title="Show preview"
                    onClick={() => setPreviewOpen(true)}
                  >
                    <PanelRightOpen size={15} />
                  </button>
                ) : null}
              </header>

              <StickToBottom className="sindri-thread" resize="smooth" initial="smooth">
                <StickToBottom.Content className="sindri-thread-content">
                  {messages.map((m) => (
                    <MessageView key={m.seq} message={m} results={results} />
                  ))}
                  {liveThinking ? <Reasoning text={liveThinking} live /> : null}
                  {liveText ? (
                    <div className="sindri-msg is-assistant">
                      <div className="sindri-bubble">
                        <Response text={liveText} />
                      </div>
                    </div>
                  ) : null}
                  {running ? (
                    <div className="sindri-status">
                      <span className="sindri-spinner" /> {phase || "forging"}…
                    </div>
                  ) : null}
                  <ScrollToBottom />
                </StickToBottom.Content>
              </StickToBottom>

              {/* composer = cockpit: the controls live where the hand acts */}
              <div className="sindri-composer">
                <textarea
                  className="sindri-input"
                  placeholder="Describe the work…  (Enter sends · Shift+Enter for a new line)"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKey}
                  rows={2}
                  disabled={running}
                />
                <div className="sindri-cockpit">
                  <div className="sindri-cockpit-controls">
                    {/* effort: a lightning chip whose signal bars fill up with the
                        reasoning level (low=1 · medium=2 · deep=3). */}
                    <label className="sindri-chip sindri-effort" title="Reasoning effort">
                      <Zap size={13} />
                      <span className="sindri-bars" data-level={effort} aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <select
                        className="sindri-chip-select"
                        value={effort}
                        onChange={(e) => {
                          setEffort(e.target.value);
                          if (sessionId) chat.patchSession(sessionId, { effort: e.target.value }).catch(() => {});
                        }}
                      >
                        {EFFORTS.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="sindri-chip sindri-model" title="Model">
                      <select
                        className="sindri-chip-select"
                        value={model}
                        onChange={(e) => {
                          setModel(e.target.value);
                          if (sessionId) chat.patchSession(sessionId, { model: e.target.value }).catch(() => {});
                        }}
                      >
                        {MODELS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={12} className="sindri-chip-caret" />
                    </label>
                    {/* Engine is fixed at creation (continuity lives in it) — the
                        select reflects the open session and applies to NEW chats. */}
                    <label className="sindri-chip sindri-model" title="Motor (vale para novos chats)">
                      <select
                        className="sindri-chip-select"
                        value={engine}
                        onChange={(e) => setEngine(e.target.value)}
                      >
                        {ENGINES.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={12} className="sindri-chip-caret" />
                    </label>
                  </div>
                  {running ? (
                    <Button
                      variant="destructive"
                      onClick={stop}
                      className="sindri-send"
                      title="Stop"
                      aria-label="Stop"
                    >
                      <Square size={16} />
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      onClick={() => send()}
                      disabled={!input.trim()}
                      className="sindri-send"
                      title="Send (Enter)"
                      aria-label="Send"
                    >
                      <Send size={16} />
                    </Button>
                  )}
                </div>
              </div>
            </>
          </section>
          ) : null}

          {/* draggable gutter — only when both panes share the stage */}
          {previewOpen && !chatCollapsed ? (
            <div
              className={`sindri-gutter ${dragging ? "is-dragging" : ""}`}
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={Math.round(split * 100)}
              aria-label="Resize panes (double-click resets)"
              title="Drag to resize · double-click resets"
              onPointerDown={startDrag}
              onDoubleClick={resetSplit}
            >
              <span className="sindri-gutter-grip" />
            </div>
          ) : null}

          {/* ── live preview column ── */}
          {previewOpen ? (
            <SindriPreview
              sessionId={sessionId}
              projectId={projectId}
              branch={currentSession?.branch ?? null}
              sawEdit={sawEdit}
              zen={chatCollapsed}
              onToggleZen={() => setChatCollapsed((c) => !c)}
              onHide={() => setPreviewOpen(false)}
              device={device}
              setDevice={setDevice}
              mobileOnly={mobileOnly}
              tokensIn={tokens.tin}
              tokensOut={tokens.tout}
            />
          ) : null}
        </div>
      )}
    </main>
  );
}

// ── live preview pane (the right-pane sandbox) ────────────────────────────────
// The project's `<app>-dev` singleton: one persistent `next dev` (HMR) server per
// app, on <app>-dev.preview.coldcodelabs.com. Sindri's edits land on `dev` and the
// forge refreshes the singleton's checkout, so HMR reflects them. Lazy: auto-boots
// on the first file edit (sawEdit), or on the "Subir preview" button.
// Viewports reais de aparelho pro modo mobile-exclusivo (projeto Expo). O
// preview NÃO é redimensionável à mão — troca-se de aparelho, como num device
// lab. Medidas = viewport CSS (pt) dos aparelhos.
const PHONE_PRESETS = [
  { id: "iphone-se", label: "iPhone SE", w: 375, h: 667 },
  { id: "iphone-15-pro", label: "iPhone 15 Pro", w: 393, h: 852 },
  { id: "iphone-16-pro-max", label: "iPhone 16 Pro Max", w: 440, h: 956 },
  { id: "pixel-8", label: "Pixel 8", w: 412, h: 915 },
  { id: "galaxy-s24", label: "Galaxy S24", w: 360, h: 780 },
] as const;

/** Read-only inspector for the env the supervisor loaded into a preview. Shows
 *  which backend a dev preview is actually wired to (isolated <app>_dev, never
 *  prod); secret values arrive already masked from the runner. */
function EnvPanel({ env }: { env: Record<string, string> | null }) {
  const entries = env ? Object.entries(env).sort(([a], [b]) => a.localeCompare(b)) : [];
  return (
    <div style={{ height: "100%", overflow: "auto", padding: "12px 14px", fontSize: 12.5 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, opacity: 0.75, marginBottom: 10 }}>
        <KeyRound size={14} />
        <strong>Environment loaded into this preview</strong>
        <span style={{ opacity: 0.6 }}>— secrets masked; backend URLs shown</span>
      </div>
      {entries.length === 0 ? (
        <div style={{ opacity: 0.6 }}>No env captured yet — the preview stamps it on boot.</div>
      ) : (
        <table
          style={{
            borderCollapse: "collapse",
            width: "100%",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
          }}
        >
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <td
                  style={{
                    padding: "3px 12px 3px 0",
                    verticalAlign: "top",
                    whiteSpace: "nowrap",
                    opacity: 0.8,
                  }}
                >
                  {k}
                </td>
                <td style={{ padding: "3px 0", wordBreak: "break-all", opacity: 0.95 }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SindriPreview({
  sessionId,
  projectId,
  branch,
  sawEdit,
  zen,
  onToggleZen,
  onHide,
  device,
  setDevice,
  mobileOnly,
  tokensIn,
  tokensOut,
}: {
  sessionId: string;
  projectId: string;
  branch: string | null;
  sawEdit: boolean;
  zen: boolean;
  onToggleZen: () => void;
  onHide: () => void;
  device: "desktop" | "mobile";
  setDevice: (d: "desktop" | "mobile") => void;
  mobileOnly: boolean;
  tokensIn: number;
  tokensOut: number;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [iframeKey, setIframeKey] = useState(0);
  // The stage shows either the live preview iframe or the read-only DB Studio.
  const [view, setView] = useState<"preview" | "code" | "database" | "env">("preview");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageW, setStageW] = useState(0);
  const [stageH, setStageH] = useState(0);
  const [phoneId, setPhoneId] = useState<string>(PHONE_PRESETS[1].id);
  const phone = PHONE_PRESETS.find((p) => p.id === phoneId) ?? PHONE_PRESETS[1];
  const autoTried = useRef(""); // projectId we've already auto-booted for
  const wokeFor = useRef(""); // projectId we've already auto-woken a stopped singleton for

  // Ensure (or reuse) the project's `<app>-dev` singleton preview.
  const ensure = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setErr("");
    try {
      setPreview(await brokk.createPreview({ projectId }));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  // On project change: reset + load the project's active singleton preview (the
  // one shared by every chat session of this app), if it's already up.
  useEffect(() => {
    setPreview(null);
    setErr("");
    setDevice(mobileOnly ? "mobile" : "desktop");
    autoTried.current = "";
    wokeFor.current = "";
    if (!projectId) return;
    let cancelled = false;
    brokk.listPreviews(projectId).then(
      (ps) => {
        if (cancelled) return;
        setPreview(ps.find((x) => x.status === "starting" || x.status === "live") ?? null);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, setDevice, mobileOnly]);

  // Lazy auto-start: once Sindri makes its first file edit, ensure the singleton
  // is up (once per project). The manual button covers every other case.
  useEffect(() => {
    if (sawEdit && !preview && !busy && projectId && autoTried.current !== projectId) {
      autoTried.current = projectId;
      void ensure();
    }
  }, [sawEdit, preview, busy, projectId, ensure]);

  // A stopped singleton (process exit / manual stop): wake it automatically so the
  // pane reflects reality instead of a stale "parado" dead-end. Once per project.
  useEffect(() => {
    if (preview?.status === "stopped" && !busy && projectId && wokeFor.current !== projectId) {
      wokeFor.current = projectId;
      void ensure();
    }
  }, [preview?.status, busy, projectId, ensure]);

  // Poll status while starting (4s); slow-poll while live/stopped (12s) so the
  // pane catches both a stop (live→stopped) and an external wake (stopped→live,
  // e.g. someone opened the preview URL directly) without a manual refresh.
  useEffect(() => {
    const status = preview?.status;
    const id = preview?.id;
    if (!id || (status !== "starting" && status !== "live" && status !== "stopped")) return;
    const iv = setInterval(
      () => brokk.getPreview(id).then(setPreview, () => {}),
      status === "starting" ? 4000 : 12000,
    );
    return () => clearInterval(iv);
  }, [preview?.status, preview?.id]);

  // Measure the actual rendered viewport so the toolbar shows a real px readout
  // (like devtools) — it updates live as the gutter re-balances the panes.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      setStageW(Math.round(entries[0]?.contentRect.width ?? 0));
      setStageH(Math.round(entries[0]?.contentRect.height ?? 0));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const status = preview?.status;
  const live = status === "live";
  const dimLabel = mobileOnly
    ? `${phone.w}×${phone.h}`
    : device === "mobile"
      ? "390px"
      : stageW
        ? `${stageW}px`
        : "auto";
  // Escala o viewport do aparelho pra caber no palco sem redimensionar o app —
  // o iframe roda no px REAL do aparelho; só a apresentação encolhe.
  const phoneScale = Math.min(
    1,
    stageW ? (stageW - 28) / phone.w : 1,
    stageH ? (stageH - 28) / phone.h : 1,
  );
  const statusColor =
    status === "live"
      ? STATUS_COLOR.done
      : status === "starting"
        ? STATUS_COLOR.running
        : status === "failed"
          ? STATUS_COLOR.failed
          : theme.textMuted;
  const statusLabel =
    status === "live"
      ? "live"
      : status === "starting"
        ? "starting…"
        : status === "failed"
          ? "failed"
          : status === "unsupported"
            ? "no runtime"
            : status === "stopped"
              ? "stopped"
              : "preview";

  return (
    <section className="sindri-preview">
      <div className="sindri-preview-bar">
        {/* far left: collapse/expand-chat toggles, then the view switcher */}
        <button
          type="button"
          className="sindri-preview-icon"
          title="Hide preview"
          onClick={onHide}
        >
          <PanelRightClose size={15} />
        </button>
        <button
          type="button"
          className={`sindri-preview-icon ${zen ? "is-on" : ""}`}
          title={zen ? "Restore chat" : "Preview full-screen"}
          onClick={onToggleZen}
        >
          {zen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <span className="sindri-preview-sep" />
        <div className="sindri-viewswitch" role="tablist" aria-label="View">
          <button
            type="button"
            className={`sindri-preview-icon ${view === "preview" ? "is-on" : ""}`}
            title="Preview"
            onClick={() => setView("preview")}
          >
            <Eye size={15} />
          </button>
          <button
            type="button"
            className={`sindri-preview-icon ${view === "code" ? "is-on" : ""}`}
            title="Code"
            onClick={() => setView("code")}
          >
            <Code2 size={15} />
          </button>
          <button
            type="button"
            className={`sindri-preview-icon ${view === "database" ? "is-on" : ""}`}
            title="Database"
            onClick={() => setView("database")}
          >
            <Database size={15} />
          </button>
          <button
            type="button"
            className={`sindri-preview-icon ${view === "env" ? "is-on" : ""}`}
            title="Environment variables"
            onClick={() => setView("env")}
          >
            <KeyRound size={15} />
          </button>
        </div>
        <span className="sindri-preview-sep" />
        <span className="sindri-preview-statuschip">
          <span className="sindri-preview-dot" style={{ background: statusColor }} />
          {statusLabel}
        </span>
        {/* branch chip hidden (ADR 0038): the session worktree is dev-lane
            plumbing — noise in the v0-face preview cockpit. */}
        {tokensIn > 0 && tokensOut > 0 ? (
          <span className="sindri-preview-tok" title="Session tokens (in · out)">
            {fmtTokens(tokensIn)} · {fmtTokens(tokensOut)}
          </span>
        ) : null}
        <span className="sindri-preview-spacer" />
        <div className="sindri-preview-actions">
          {mobileOnly ? (
            // Projeto mobile: sem toggle desktop, sem drag — troca-se de aparelho.
            <select
              className="sindri-preview-device"
              title="Preview device"
              value={phoneId}
              onChange={(e) => setPhoneId(e.target.value)}
            >
              {PHONE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          ) : (
            // device = a single segmented control (one paradigm), not two loose
            // buttons — matches the view switcher on the far left.
            <div className="sindri-viewswitch sindri-devswitch" role="group" aria-label="Device width">
              <button
                type="button"
                className={`sindri-preview-icon ${device === "desktop" ? "is-on" : ""}`}
                title="Desktop width"
                onClick={() => setDevice("desktop")}
              >
                <Monitor size={15} />
              </button>
              <button
                type="button"
                className={`sindri-preview-icon ${device === "mobile" ? "is-on" : ""}`}
                title="Mobile width"
                onClick={() => setDevice("mobile")}
              >
                <Smartphone size={15} />
              </button>
            </div>
          )}
          {/* viewport width is a READOUT, not a control (crit #9) */}
          <span className="sindri-preview-dim" title="Viewport" aria-live="polite">
            {dimLabel}
          </span>
          <button
            type="button"
            className="sindri-preview-icon"
            title="Reload"
            disabled={!live}
            onClick={() => setIframeKey((k) => k + 1)}
          >
            <RotateCw size={15} />
          </button>
          <a
            className={`sindri-preview-icon ${live ? "" : "is-disabled"}`}
            title="Open in new tab"
            href={live ? preview?.url : undefined}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={15} />
          </a>
          {/* separator splits the browser-chrome group from the one hot action */}
          <span className="sindri-preview-sep" />
          <PublishControls projectId={projectId} />
        </div>
      </div>

      <div className="sindri-preview-stage" ref={stageRef}>
        {view === "code" ? (
          <FileViewer sessionId={sessionId} />
        ) : view === "database" ? (
          <StudioPanel previewId={preview?.id ?? null} />
        ) : view === "env" ? (
          <EnvPanel env={preview?.loadedEnv ?? null} />
        ) : live && preview ? (
          mobileOnly ? (
            // Aparelho real: o iframe roda no px exato do device escolhido e a
            // moldura toda escala pra caber no palco (o app nunca "vira desktop").
            <div className="sindri-preview-frame is-phone">
              <div
                className="sindri-phone"
                style={{
                  width: phone.w,
                  height: phone.h,
                  transform: `scale(${phoneScale})`,
                }}
              >
                <iframe
                  key={iframeKey}
                  src={preview.url}
                  title={`Preview — ${phone.label}`}
                  className="sindri-preview-iframe"
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
                />
              </div>
            </div>
          ) : (
            <div className={`sindri-preview-frame is-${device}`}>
              <iframe
                key={iframeKey}
                src={preview.url}
                title="Live preview"
                className="sindri-preview-iframe"
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
              />
            </div>
          )
        ) : (
          // Never a naked checkered void: the non-live states sit inside a
          // browser-window mock, so the stage always reads as a screen.
          <div className="sindri-preview-window">
            <div className="sindri-preview-window-bar">
              <span className="sindri-preview-dots">
                <i />
                <i />
                <i />
              </span>
              <span className="sindri-preview-window-url">
                {preview?.url?.replace(/^https?:\/\//, "") ?? branch ?? "preview"}
              </span>
            </div>
            <div className="sindri-preview-window-body">
              {status === "starting" ? (
                <div className="sindri-preview-msg">
                  <span className="sindri-spinner" />
                  <p>Starting preview…</p>
                  {/* Live phase from the supervisor (preparing code →
                      provisioning db → migrations → install/build),
                      falling back to the generic hint before the first phase lands. */}
                  <span className="sindri-preview-sub">
                    {preview?.detail || "First boot takes ~1 min."}
                  </span>
                </div>
              ) : status === "failed" ? (
                <div className="sindri-preview-msg">
                  <div className="sindri-preview-mark is-err">
                    <RotateCw size={24} strokeWidth={1.5} />
                  </div>
                  <p>Preview failed to boot.</p>
                  {err ? <span className="sindri-preview-sub">{err}</span> : null}
                  <Button variant="default" onClick={ensure} disabled={busy}>
                    <RotateCw size={15} /> Retry
                  </Button>
                </div>
              ) : status === "unsupported" ? (
                // Huginn knew up front there's no supported runtime to boot —
                // a clean explained state, not a failure to retry.
                <div className="sindri-preview-msg">
                  <div className="sindri-preview-mark">
                    <Monitor size={26} strokeWidth={1.4} />
                  </div>
                  <p>No supported runtime in this repo.</p>
                  {preview?.detail ? (
                    <span className="sindri-preview-sub">{preview.detail}</span>
                  ) : (
                    <span className="sindri-preview-sub">
                      Previews boot Next.js apps today; other stacks are detected but not
                      booted yet.
                    </span>
                  )}
                </div>
              ) : (
                <div className="sindri-preview-msg">
                  <div className="sindri-preview-mark">
                    <Monitor size={26} strokeWidth={1.4} />
                  </div>
                  <p>No preview running</p>
                  <span className="sindri-preview-sub">
                    It boots on Sindri&apos;s first edit — or start it now.
                  </span>
                  <Button variant="default" onClick={ensure} disabled={busy || !branch}>
                    {busy ? <span className="sindri-spinner" /> : <Plus size={15} />} Start preview
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ── one transcript message ──────────────────────────────────────────────────
function MessageView({
  message,
  results,
}: {
  message: ChatMessage;
  results: Map<string, Block & { type: "tool_result" }>;
}) {
  // A user message that's ONLY tool results is rendered as part of the tools, not
  // as a user bubble — skip it here (the tool_use blocks render their results).
  const onlyResults = message.role === "user" && message.blocks.every((b) => b.type === "tool_result");
  if (onlyResults) return null;

  const isUser = message.role === "user";
  const text = message.blocks
    .filter((b): b is Block & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const thinking = message.blocks
    .filter((b): b is Block & { type: "thinking" } => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n")
    .trim();
  const tools = message.blocks.filter((b): b is Block & { type: "tool_use" } => b.type === "tool_use");

  return (
    <div className={`sindri-msg ${isUser ? "is-user" : "is-assistant"}`}>
      <div className="sindri-bubble">
        {thinking && !isUser ? <Reasoning text={thinking} /> : null}
        {text ? isUser ? <pre className="sindri-text">{text}</pre> : <Response text={text} /> : null}
        {tools.map((t) => (
          <ToolCall key={t.id} tool={t} result={results.get(t.id)} />
        ))}
        {!isUser ? <TurnSummary tools={tools} /> : null}
        {!isUser && text ? <MessageActions text={text} /> : null}
      </div>
    </div>
  );
}

// ── turn summary ──────────────────────────────────────────────────────────────
// A one-glance recap of what a turn actually changed, derived from the message's
// own tool blocks (no extra data): how many actions, and which files were touched.
// Renders only when files were edited — a pure read/run turn stays clean.
function TurnSummary({ tools }: { tools: (Block & { type: "tool_use" })[] }) {
  const files = useMemo(() => {
    const set = new Set<string>();
    for (const t of tools) {
      if (!EDIT_TOOL.test(t.name)) continue;
      const p = (t.input.file_path as string) || (t.input.path as string);
      if (p) set.add(p.split("/").pop() || p);
    }
    return [...set];
  }, [tools]);
  if (!files.length) return null;
  return (
    <div className="sindri-turn-meta">
      <span className="sindri-turn-stat">
        <Wrench size={11} /> {tools.length} {tools.length === 1 ? "action" : "actions"}
      </span>
      <span className="sindri-head-sep">·</span>
      <span className="sindri-turn-stat">
        <FileEdit size={11} /> {files.length} {files.length === 1 ? "file" : "files"}
      </span>
      <span className="sindri-turn-files" title={files.join(", ")}>
        {files.slice(0, 4).join(", ")}
        {files.length > 4 ? ` +${files.length - 4}` : ""}
      </span>
    </div>
  );
}

// Map raw tool names to a friendly verb + icon, so a turn reads like a story of
// what Sindri did rather than a list of API calls.
const TOOL_META: { match: RegExp; label: string; Icon: typeof Wrench }[] = [
  { match: /read|cat|view|get_file/i, label: "Reading", Icon: FileText },
  { match: /write|edit|str_replace|create|apply|patch/i, label: "Editing", Icon: FileEdit },
  { match: /bash|shell|run|exec|command|terminal/i, label: "Running", Icon: TerminalSquare },
  { match: /card|task|plan|todo/i, label: "Planning", Icon: ListTodo },
  { match: /pr|pull|merge|commit|push|branch/i, label: "Git", Icon: GitPullRequest },
];

function toolMeta(name: string) {
  return TOOL_META.find((t) => t.match.test(name)) ?? { label: "Tool", Icon: Wrench };
}

function ToolCall({
  tool,
  result,
}: {
  tool: Block & { type: "tool_use" };
  result?: Block & { type: "tool_result" };
}) {
  const [open, setOpen] = useState(false);
  const { label, Icon } = toolMeta(tool.name);
  const arg =
    (tool.input.command as string) ||
    (tool.input.path as string) ||
    (tool.input.title as string) ||
    (tool.input.file_path as string) ||
    JSON.stringify(tool.input);
  const status = !result ? "running" : result.is_error ? "error" : "ok";
  return (
    <div className={`sindri-tool ${result?.is_error ? "is-error" : ""}`}>
      <button className="sindri-tool-head" onClick={() => setOpen((o) => !o)}>
        <Icon size={13} className="sindri-tool-icon" />
        <span className="sindri-tool-name">{label}</span>
        <span className="sindri-tool-arg">{String(arg).slice(0, 90)}</span>
        <span className={`sindri-tool-pill is-${status}`}>
          {status === "running" ? <span className="sindri-spinner" /> : status === "error" ? "error" : "ok"}
        </span>
        <ChevronDown size={13} className={`sindri-tool-caret ${open ? "is-open" : ""}`} />
      </button>
      {open ? (
        <div className="sindri-tool-body">
          <div className="sindri-tool-label">
            {tool.name} · input
          </div>
          <pre className="sindri-pre">{JSON.stringify(tool.input, null, 2)}</pre>
          {result ? (
            <>
              <div className="sindri-tool-label">result</div>
              <pre className="sindri-pre">{result.content.slice(0, 4000)}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── streaming markdown ────────────────────────────────────────────────────────
// Streamdown renders partial/unterminated markdown safely mid-stream (unclosed
// code fences, half-typed links) and ships GFM tables, Shiki syntax highlighting,
// HTML sanitization and a built-in copy button on code blocks. We only restyle it
// with our design tokens — light/dark shiki themes track the forge theme.
const SHIKI_THEME: NonNullable<React.ComponentProps<typeof Streamdown>["shikiTheme"]> = [
  "github-light",
  "github-dark",
];

function Response({ text }: { text: string }) {
  return (
    <Streamdown className="sindri-md" parseIncompleteMarkdown shikiTheme={SHIKI_THEME}>
      {text}
    </Streamdown>
  );
}

// ── reasoning (extended thinking) ─────────────────────────────────────────────
// The backend streams `thinking_delta` and persists `thinking` blocks; before,
// the UI dropped both. Surface them in a quiet, collapsible panel — open while
// live so you can watch Sindri reason, collapsible once the answer lands.
function Reasoning({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(!!live);
  if (!text.trim()) return null;
  return (
    <div className={`sindri-reasoning ${live ? "is-live" : ""}`}>
      <button className="sindri-reasoning-head" onClick={() => setOpen((o) => !o)}>
        <Brain size={13} className={live ? "sindri-reasoning-pulse" : ""} />
        <span>{live ? "Thinking…" : "Reasoning"}</span>
        <ChevronDown size={13} className={`sindri-reasoning-caret ${open ? "is-open" : ""}`} />
      </button>
      {open ? (
        <div className="sindri-reasoning-body">
          <Streamdown className="sindri-md" parseIncompleteMarkdown>
            {text}
          </Streamdown>
        </div>
      ) : null}
    </div>
  );
}

// ── per-message actions ───────────────────────────────────────────────────────
function MessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="sindri-msg-actions">
      <button
        title="Copy reply"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            },
            () => {},
          );
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

// ── scroll-to-bottom affordance ───────────────────────────────────────────────
// use-stick-to-bottom keeps the thread pinned during streaming but releases the
// moment the operator scrolls up to read back; this button re-pins on demand.
function ScrollToBottom() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button className="sindri-scroll-btn" onClick={() => scrollToBottom()} title="Jump to latest">
      <ArrowDown size={15} />
    </button>
  );
}
