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
  Pencil,
  MessageSquare,
  Zap,
  Cpu,
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
  ExternalLink,
  PanelRightClose,
  PanelRightOpen,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useProject } from "../lib/project-context";
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
  { id: "low", label: "Leve" },
  { id: "medium", label: "Médio" },
  { id: "high", label: "Profundo" },
];

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
  if (s < 45) return "agora";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  if (d === 1) return "ontem";
  if (d < 30) return `${d} d`;
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
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
  const [model, setModel] = useState("sonnet");
  const [effort, setEffort] = useState("medium");
  const [sessions, setSessions] = useState<ChatSessionWithStats[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [liveThinking, setLiveThinking] = useState("");
  const [phase, setPhase] = useState("");
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  // Right-pane preview can be collapsed to give the chat full width.
  const [previewOpen, setPreviewOpen] = useState(true);
  // Zen/focus: collapse the chat so the preview goes full-bleed (demo mode).
  const [chatCollapsed, setChatCollapsed] = useState(false);
  // Draggable split ratio (chat fraction) when both panes are open.
  const [split, setSplit] = useState(0.42);
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
      const s = await chat.createSession({ projectId, model, effort }).catch(() => null);
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
    const s = await chat.createSession({ projectId, model, effort });
    const withStats: ChatSessionWithStats = {
      ...s,
      stats: { messages: 0, tokensIn: 0, tokensOut: 0, lastMessageAt: null },
    };
    setSessions((prev) => [withStats, ...prev]);
    await openSession(s.id);
  }

  async function send() {
    const text = input.trim();
    if (!text || !sessionId || running) return;
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
      await sendMessage(sessionId, text, handleEvent, ac.signal);
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
    if (!confirm("Apagar este chat?")) return;
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
  // neither pane ever collapses by accident (use the zen/hide toggles for that).
  function startDrag(e: React.PointerEvent) {
    e.preventDefault();
    const el = bodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const r = (ev.clientX - rect.left) / rect.width;
      setSplit(Math.min(0.72, Math.max(0.28, r)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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

  // Live stats for the open session: aggregate token usage from loaded messages,
  // so the strip stays honest even mid-turn (before the list re-fetches).
  const liveStats = useMemo(() => {
    let tin = 0;
    let tout = 0;
    let turns = 0;
    for (const m of messages) {
      if (m.role === "user" && m.blocks.some((b) => b.type === "text")) turns++;
      const u = (m.meta as { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } } | null)?.usage;
      if (u) {
        tin += (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0);
        tout += u.outputTokens ?? 0;
      }
    }
    // Fall back to the rail's aggregate when the open transcript carries no meta.
    if (!tin && !tout && currentSession) {
      tin = currentSession.stats.tokensIn;
      tout = currentSession.stats.tokensOut;
    }
    return { turns, tokensIn: tin, tokensOut: tout };
  }, [messages, currentSession]);

  return (
    <main className="sindri">
      {/* ── top: session tabs (horizontal scroll) ── */}
      <div className="sindri-tabs">
        <Button
          variant="default"
          onClick={newChat}
          disabled={!projectId}
          className="sindri-tab-new"
        >
          <Plus size={15} /> Novo chat
        </Button>
        <div className="sindri-tabs-scroll">
          {sortedSessions.length === 0 ? (
            <span className="sindri-tabs-empty">
              {currentProject
                ? `Sem conversas em ${currentProject.name} ainda.`
                : "Selecione um ambiente no menu lateral."}
            </span>
          ) : (
            sortedSessions.map((s) => (
              <button
                key={s.id}
                className={`sindri-tab ${s.id === sessionId ? "is-active" : ""}`}
                onClick={() => openSession(s.id)}
                title={`${s.title} · ${relTime(sessionTime(s))}`}
              >
                {s.turnState === "running" ? <span className="sindri-dot" /> : null}
                <span className="sindri-tab-title">{s.title}</span>
                <span
                  className="sindri-tab-del"
                  title="Apagar conversa"
                  onClick={(e) => removeSession(s.id, e)}
                >
                  <Trash2 size={12} />
                </span>
              </button>
            ))
          )}
        </div>
      </div>

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
              <Hammer size={34} strokeWidth={1.4} />
            </div>
            <h3>{currentProject ? `Trabalhe ${currentProject.name} com Sindri` : "Selecione um ambiente"}</h3>
            <p>
              Abra um novo chat: ele clona o repositório e trabalha numa branch própria — lê, edita,
              roda, e mostra o preview ao vivo das mudanças ao lado.
            </p>
            <Button variant="default" onClick={newChat} disabled={!projectId}>
              <Plus size={16} /> Novo chat
            </Button>
          </div>
        </div>
      ) : (
        <div
          ref={bodyRef}
          className={`sindri-body ${!previewOpen ? "is-solo" : ""} ${chatCollapsed ? "is-zen" : ""}`}
          style={
            previewOpen && !chatCollapsed
              ? { gridTemplateColumns: `minmax(0, ${split}fr) 8px minmax(0, ${1 - split}fr)` }
              : undefined
          }
        >
          {/* ── chat column ── */}
          {!chatCollapsed ? (
          <section className="sindri-chat">
            <>
              {/* session header — one slim row: title · branch · meta · toggle */}
              <header className="sindri-head">
                {renaming ? (
                  <input
                    className="sindri-title-input"
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={saveTitle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveTitle();
                      if (e.key === "Escape") setRenaming(false);
                    }}
                  />
                ) : (
                  <h2
                    className="sindri-title"
                    onDoubleClick={() => {
                      setTitleDraft(currentSession?.title ?? "");
                      setRenaming(true);
                    }}
                  >
                    <span className="sindri-title-text">{currentSession?.title}</span>
                    <button
                      className="sindri-title-edit"
                      title="Renomear"
                      onClick={() => {
                        setTitleDraft(currentSession?.title ?? "");
                        setRenaming(true);
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                  </h2>
                )}
                {currentSession?.branch ? (
                  <span className="sindri-ctx-branch">
                    <GitBranch size={11} /> {currentSession.branch}
                  </span>
                ) : null}
                <span className="sindri-head-meta">
                  <MessageSquare size={11} /> {liveStats.turns}
                  <span className="sindri-head-sep">·</span>
                  {currentSession ? relTime(sessionTime(currentSession)) || "agora" : "agora"}
                </span>
                <button
                  type="button"
                  className="sindri-preview-toggle"
                  title={previewOpen ? "Ocultar preview" : "Mostrar preview"}
                  onClick={() => setPreviewOpen((o) => !o)}
                >
                  {previewOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
                </button>
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
                      <span className="sindri-spinner" /> {phase || "working"}…
                    </div>
                  ) : null}
                  <ScrollToBottom />
                </StickToBottom.Content>
              </StickToBottom>

              {/* composer = cockpit: the controls live where the hand acts */}
              <div className="sindri-composer">
                <textarea
                  className="sindri-input"
                  placeholder="Peça algo ao Sindri…  (Enter envia, Shift+Enter quebra linha)"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKey}
                  rows={2}
                  disabled={running}
                />
                <div className="sindri-cockpit">
                  <div className="sindri-cockpit-controls">
                    <label className="sindri-chip" title="Modelo">
                      <Cpu size={13} />
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
                    </label>
                    <label className="sindri-chip" title="Esforço de raciocínio">
                      <Zap size={13} />
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
                    <span className="sindri-cockpit-tok" title="Tokens nesta sessão">
                      {fmtTokens(liveStats.tokensIn)} · {fmtTokens(liveStats.tokensOut)}
                    </span>
                  </div>
                  {running ? (
                    <Button
                      variant="destructive"
                      onClick={stop}
                      className="sindri-send"
                      title="Parar"
                      aria-label="Parar"
                    >
                      <Square size={16} />
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      onClick={send}
                      disabled={!input.trim()}
                      className="sindri-send"
                      title="Enviar (Enter)"
                      aria-label="Enviar"
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
              className="sindri-gutter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Redimensionar painéis"
              onPointerDown={startDrag}
            >
              <span className="sindri-gutter-grip" />
            </div>
          ) : null}

          {/* ── live preview column ── */}
          {previewOpen ? (
            <SindriPreview
              sessionId={sessionId}
              branch={currentSession?.branch ?? null}
              sawEdit={sawEdit}
              zen={chatCollapsed}
              onToggleZen={() => setChatCollapsed((c) => !c)}
            />
          ) : null}
        </div>
      )}
    </main>
  );
}

// ── live preview pane (the right-pane sandbox) ────────────────────────────────
// A `next dev` (HMR) server runs in THIS session's checkout, so Sindri's edits
// hot-reload here and on the public preview URL — one server serving both. Lazy:
// auto-boots on the first file edit (sawEdit), or on the "Subir preview" button.
function SindriPreview({
  sessionId,
  branch,
  sawEdit,
  zen,
  onToggleZen,
}: {
  sessionId: string;
  branch: string | null;
  sawEdit: boolean;
  zen: boolean;
  onToggleZen: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [iframeKey, setIframeKey] = useState(0);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const autoTried = useRef(""); // sessionId we've already auto-booted for
  const wokeFor = useRef(""); // sessionId we've already auto-woken a reaped preview for

  const ensure = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      setPreview(await chat.ensurePreview(sessionId));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  // On session change: reset + load any existing preview for it.
  useEffect(() => {
    setPreview(null);
    setErr("");
    setDevice("desktop");
    autoTried.current = "";
    wokeFor.current = "";
    let cancelled = false;
    chat.getPreview(sessionId).then(
      (pv) => !cancelled && setPreview(pv),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Lazy auto-start: once Sindri makes its first file edit, boot the preview
  // (once per session). The manual button covers every other case.
  useEffect(() => {
    if (sawEdit && !preview && !busy && autoTried.current !== sessionId) {
      autoTried.current = sessionId;
      void ensure();
    }
  }, [sawEdit, preview, busy, sessionId, ensure]);

  // A reaped/idle preview (status 'stopped') for the session we're looking at:
  // wake it automatically so the pane reflects reality instead of a stale
  // "parado" dead-end. The gateway already wakes a preview when its URL is hit
  // directly — this does the same the moment the session is open, so the user
  // sees "subindo… → ao vivo" rather than having to click "Subir preview".
  // Only resumes a preview that ALREADY existed (was booted before); a session
  // that never had one keeps the lazy/manual flow.
  useEffect(() => {
    if (preview?.status === "stopped" && !busy && wokeFor.current !== sessionId) {
      wokeFor.current = sessionId;
      void ensure();
    }
  }, [preview?.status, busy, sessionId, ensure]);

  // Poll status while starting (4s); slow-poll while live/stopped (12s) so the
  // pane catches both a reap (live→stopped) and an external wake (stopped→live,
  // e.g. someone opened the preview URL directly) without a manual refresh.
  useEffect(() => {
    const status = preview?.status;
    if (status !== "starting" && status !== "live" && status !== "stopped") return;
    const id = setInterval(
      () => chat.getPreview(sessionId).then(setPreview, () => {}),
      status === "starting" ? 4000 : 12000,
    );
    return () => clearInterval(id);
  }, [preview?.status, sessionId]);

  const status = preview?.status;
  const live = status === "live";
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
      ? "ao vivo"
      : status === "starting"
        ? "subindo…"
        : status === "failed"
          ? "falhou"
          : status === "unsupported"
            ? "sem runtime"
            : status === "stopped"
              ? "parado"
              : "preview";

  return (
    <section className="sindri-preview">
      <div className="sindri-preview-bar">
        <span className="sindri-preview-statuschip">
          <span className="sindri-preview-dot" style={{ background: statusColor }} />
          {statusLabel}
        </span>
        {preview ? (
          <a
            className="sindri-preview-url"
            href={preview.url}
            target="_blank"
            rel="noreferrer"
            title={preview.url}
          >
            {preview.url.replace(/^https?:\/\//, "")}
          </a>
        ) : (
          <span className="sindri-preview-url is-empty">{branch ? branch : "sem branch"}</span>
        )}
        <div className="sindri-preview-actions">
          <button
            type="button"
            className={`sindri-preview-icon ${device === "desktop" ? "is-on" : ""}`}
            title="Largura desktop"
            onClick={() => setDevice("desktop")}
          >
            <Monitor size={15} />
          </button>
          <button
            type="button"
            className={`sindri-preview-icon ${device === "mobile" ? "is-on" : ""}`}
            title="Largura mobile"
            onClick={() => setDevice("mobile")}
          >
            <Smartphone size={15} />
          </button>
          <button
            type="button"
            className="sindri-preview-icon"
            title="Recarregar"
            disabled={!live}
            onClick={() => setIframeKey((k) => k + 1)}
          >
            <RotateCw size={15} />
          </button>
          <a
            className={`sindri-preview-icon ${live ? "" : "is-disabled"}`}
            title="Abrir em nova aba"
            href={live ? preview?.url : undefined}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={15} />
          </a>
          <span className="sindri-preview-sep" />
          <button
            type="button"
            className={`sindri-preview-icon ${zen ? "is-on" : ""}`}
            title={zen ? "Restaurar o chat" : "Foco: preview em tela cheia"}
            onClick={onToggleZen}
          >
            {zen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </div>

      <div className="sindri-preview-stage">
        {live && preview ? (
          <div className={`sindri-preview-frame is-${device}`}>
            <iframe
              key={iframeKey}
              src={preview.url}
              title="Preview ao vivo"
              className="sindri-preview-iframe"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            />
          </div>
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
                  <p>Subindo o ambiente de preview…</p>
                  <span className="sindri-preview-sub">A primeira subida pode levar ~1 min.</span>
                </div>
              ) : status === "failed" ? (
                <div className="sindri-preview-msg">
                  <div className="sindri-preview-mark is-err">
                    <RotateCw size={24} strokeWidth={1.5} />
                  </div>
                  <p>O preview falhou ao subir.</p>
                  {err ? <span className="sindri-preview-sub">{err}</span> : null}
                  <Button variant="default" onClick={ensure} disabled={busy}>
                    <RotateCw size={15} /> Tentar de novo
                  </Button>
                </div>
              ) : status === "unsupported" ? (
                // Huginn knew up front there's no supported runtime to boot —
                // a clean explained state, not a failure to retry.
                <div className="sindri-preview-msg">
                  <div className="sindri-preview-mark">
                    <Monitor size={26} strokeWidth={1.4} />
                  </div>
                  <p>Este repositório ainda não tem um runtime suportado.</p>
                  {preview?.detail ? (
                    <span className="sindri-preview-sub">{preview.detail}</span>
                  ) : (
                    <span className="sindri-preview-sub">
                      Hoje o preview sobe apps Next.js; outros stacks são reconhecidos mas
                      ainda não bootam.
                    </span>
                  )}
                </div>
              ) : (
                <div className="sindri-preview-msg">
                  <div className="sindri-preview-mark">
                    <Monitor size={26} strokeWidth={1.4} />
                  </div>
                  <p>Preview ao vivo das mudanças</p>
                  <span className="sindri-preview-sub">
                    Sobe sozinho na primeira edição do Sindri — ou suba agora.
                  </span>
                  <Button variant="default" onClick={ensure} disabled={busy || !branch}>
                    {busy ? <span className="sindri-spinner" /> : <Plus size={15} />} Subir preview
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
        {!isUser && text ? <MessageActions text={text} /> : null}
      </div>
    </div>
  );
}

// Map raw tool names to a friendly verb + icon, so a turn reads like a story of
// what Sindri did rather than a list of API calls.
const TOOL_META: { match: RegExp; label: string; Icon: typeof Wrench }[] = [
  { match: /read|cat|view|get_file/i, label: "Lendo", Icon: FileText },
  { match: /write|edit|str_replace|create|apply|patch/i, label: "Editando", Icon: FileEdit },
  { match: /bash|shell|run|exec|command|terminal/i, label: "Executando", Icon: TerminalSquare },
  { match: /card|task|plan|todo/i, label: "Planejando", Icon: ListTodo },
  { match: /pr|pull|merge|commit|push|branch/i, label: "Git", Icon: GitPullRequest },
];

function toolMeta(name: string) {
  return TOOL_META.find((t) => t.match.test(name)) ?? { label: "Ferramenta", Icon: Wrench };
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
          {status === "running" ? <span className="sindri-spinner" /> : status === "error" ? "erro" : "ok"}
        </span>
        <ChevronDown size={13} className={`sindri-tool-caret ${open ? "is-open" : ""}`} />
      </button>
      {open ? (
        <div className="sindri-tool-body">
          <div className="sindri-tool-label">
            {tool.name} · entrada
          </div>
          <pre className="sindri-pre">{JSON.stringify(tool.input, null, 2)}</pre>
          {result ? (
            <>
              <div className="sindri-tool-label">resultado</div>
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
const SHIKI_THEME: [string, string] = ["github-light", "github-dark"];

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
        <span>{live ? "Pensando…" : "Raciocínio"}</span>
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
        title="Copiar resposta"
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
        {copied ? "copiado" : "copiar"}
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
    <button className="sindri-scroll-btn" onClick={() => scrollToBottom()} title="Ir para o final">
      <ArrowDown size={15} />
    </button>
  );
}
