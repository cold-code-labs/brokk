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
  CornerDownLeft,
  Square,
  Hammer,
  Trash2,
  Check,
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
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Columns2,
} from "lucide-react";
import { useProject } from "../lib/project-context";
import PublishControls from "./PublishControls";
import CommitControls from "./CommitControls";
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
import { ComposerChip } from "./ComposerChip";
import { ComposerMenu } from "./ComposerMenu";

// Full model choice (Claude engines only). Cursor seat is always Auto.
const MODELS = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
];
const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "Deep" },
];

// Turn engine — fixed at session creation (the engine owns the continuity).
// IDs: claude-api | claude-cli | cursor-api | cursor-cli (legacy afl/cli still accepted).
const ENGINES = [
  { id: "claude-api", label: "Claude API", hint: "LiteLLM → Ratatoskr Max seat" },
  { id: "claude-cli", label: "Claude CLI", hint: "Official Claude Code headless" },
  { id: "cursor-api", label: "Cursor API", hint: "Ratatoskr cursor sidecar · always Auto" },
  { id: "cursor-cli", label: "Cursor CLI", hint: "agent CLI · always Auto" },
];

function normalizeEngineUi(raw: string | undefined): string {
  switch ((raw ?? "claude-api").toLowerCase()) {
    case "cli":
    case "claude-cli":
      return "claude-cli";
    case "cursor-cli":
      return "cursor-cli";
    case "cursor-api":
    case "cursor":
      return "cursor-api";
    case "afl":
    case "brokk":
    case "claude-api":
    default:
      return "claude-api";
  }
}

function isCursorEngine(engine: string): boolean {
  return engine === "cursor-api" || engine === "cursor-cli";
}

type SkillOption = { name: string; description: string; kind: string };

/** Pull `/skill-name` tokens that match the catalogue; leave the rest as the prompt. */
function extractSkillSlash(
  text: string,
  known: Set<string>,
): { skill: string | null; text: string } {
  let skill: string | null = null;
  const cleaned = text.replace(/(^|\s)\/([a-z][a-z0-9-]*)\b/gi, (full, lead: string, name: string) => {
    const id = name.toLowerCase();
    if (!known.has(id)) return full;
    skill = id;
    return lead === " " ? " " : "";
  });
  return { skill, text: cleaned.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim() };
}

// Split (chat fraction) — persisted per-browser, so the balance you set survives
// reloads and session switches. Default is an even 50/50 so the conversation gets
// real width; snap points give a magnetic 50/60/68 without pixel-hunting, and
// double-clicking the gutter restores the default.
// Context window the ring measures against. Every Claude tier Brokk offers
// (haiku/sonnet/opus) carries 200k, so one constant covers them; cursor engines
// report no usage at all, so they never reach the gauge.
const CONTEXT_WINDOW = 200_000;

const RAIL_KEY = "sindri-rail-open";
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

/**
 * How full the model's head is right now — the one number a ring can honestly
 * carry. The exact figures (and what the session has spent) live in the title,
 * because a gauge is for glancing, not for reading.
 */
function ContextRing({
  context,
  spent,
}: {
  context: { used: number; window: number };
  spent: { tin: number; tout: number };
}) {
  const pct = Math.min(1, context.used / context.window);
  const r = 6;
  const circ = 2 * Math.PI * r;
  return (
    <span
      className="sindri-ring"
      title={
        `Context: ${fmtTokens(context.used)} of ${fmtTokens(context.window)} (${Math.round(pct * 100)}%)` +
        `\nSession spend: ${fmtTokens(spent.tin)} in · ${fmtTokens(spent.tout)} out`
      }
      aria-label={`Context ${Math.round(pct * 100)} percent full`}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle className="sindri-ring-track" cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" />
        <circle
          className="sindri-ring-fill"
          cx="8"
          cy="8"
          r={r}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${circ * pct} ${circ}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
    </span>
  );
}

/**
 * The session rail — the left wall of the Sindri room: New session on top, then
 * the project's sessions newest-first. Scoped to the active Anvil (the lintel
 * switcher drives it), so it lists this project's work and nothing else.
 * Rows are hairlines inside ONE surface — never a stack of bordered cards.
 */
function SessionRail({
  sessions,
  currentId,
  projectName,
  onOpen,
  onNew,
  onRemove,
  onRename,
  onCollapse,
  disabled,
}: {
  sessions: ChatSessionWithStats[];
  currentId: string;
  projectName: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRemove: (id: string, ev: React.MouseEvent) => void;
  onRename: (id: string, title: string) => void;
  onCollapse: () => void;
  disabled: boolean;
}) {
  // Renaming is the rail's business now that it owns the session list — the head
  // no longer carries a title to double-click.
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");

  return (
    <aside className="sindri-rail" aria-label="Sessions">
      {/* The rail's own header: the collapse door lives here, top-right — the app
          chrome (the lintel) stays out of this room's furniture. */}
      <div className="sindri-rail-head">
        <button
          type="button"
          className="sindri-rail-new"
          onClick={onNew}
          disabled={disabled}
          title="New session"
        >
          {/* The chip is the button; the label just names it. */}
          <span className="sindri-rail-new-mark" aria-hidden="true">
            <Plus size={14} />
          </span>
          New session
        </button>
        <button
          type="button"
          className="sindri-rail-collapse"
          onClick={onCollapse}
          title="Hide sessions"
          aria-label="Hide sessions"
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      <div className="sindri-rail-eyebrow">
        <span>Recents</span>
        <span className="sindri-rail-count">{sessions.length}</span>
      </div>

      <div className="sindri-rail-list" role="listbox" aria-label="Recent sessions">
        {sessions.length === 0 ? (
          <p className="sindri-rail-empty">
            {projectName ? `The forge is quiet in ${projectName}.` : "Pick an environment."}
          </p>
        ) : (
          sessions.map((s) => {
            const live = s.turnState === "running";
            const current = s.id === currentId;
            return (
              <div
                key={s.id}
                role="option"
                aria-selected={current}
                tabIndex={0}
                className={`sindri-rail-row ${current ? "is-current" : ""} ${live ? "is-live" : ""}`}
                onClick={() => {
                  if (!current) onOpen(s.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (!current) onOpen(s.id);
                  }
                }}
                onDoubleClick={() => {
                  setDraft(s.title);
                  setEditingId(s.id);
                }}
                title={`${s.title} · ${relTime(sessionTime(s))}${
                  s.branch ? ` · ${s.branch}` : ""
                } — double-click to rename`}
              >
                <span className="sindri-rail-row-mark" aria-hidden="true" />
                {editingId === s.id ? (
                  <input
                    className="sindri-rail-row-rename"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => {
                      onRename(s.id, draft);
                      setEditingId("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        onRename(s.id, draft);
                        setEditingId("");
                      }
                      if (e.key === "Escape") setEditingId("");
                    }}
                  />
                ) : (
                  <>
                    <span className="sindri-rail-row-title">{s.title}</span>
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`Delete ${s.title}`}
                      title="Delete session"
                      className="sindri-rail-row-del"
                      onClick={(e) => onRemove(s.id, e)}
                    >
                      <Trash2 size={12} />
                    </span>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

export default function Chat() {
  // Project selection is GLOBAL now (the sidebar AMBIENTE switcher) — Sindri reads
  // the same context, so the active environment drives which project Sindri works.
  const { projects, currentId: projectId } = useProject();
  // Projeto mobile (runtime Expo/Metro): o preview é a app RN-web num viewport
  // de celular — visualização EXCLUSIVA mobile (presets de aparelho, sem drag).
  const mobileOnly = projects.find((p) => p.id === projectId)?.runtime?.id === "expo";
  const [model, setModel] = useState("sonnet");
  const [effort, setEffort] = useState("medium");
  const [engine, setEngine] = useState("claude-api");
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashActive, setSlashActive] = useState(0);
  const [slashQuery, setSlashQuery] = useState("");
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
  // The rail can be folded away; the choice sticks per browser, like the split.
  const [railOpen, setRailOpen] = useState(true);
  useEffect(() => {
    try {
      setRailOpen(localStorage.getItem(RAIL_KEY) !== "0");
    } catch {
      /* ignore */
    }
  }, []);
  const toggleRail = useCallback((open: boolean) => {
    setRailOpen(open);
    try {
      localStorage.setItem(RAIL_KEY, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);
  // Layout triad: chat-full · split · preview-full (mutually exclusive). The
  // preview stays shut until you ask for it with the window switch — it never
  // takes half the room on its own.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  // Draggable split ratio (chat fraction) when both panes are open.
  const [split, setSplit] = useState(SPLIT_DEFAULT);
  const layout: "chat" | "split" | "preview" = !previewOpen
    ? "chat"
    : chatCollapsed
      ? "preview"
      : "split";
  const setLayout = useCallback((mode: "chat" | "split" | "preview") => {
    if (mode === "chat") {
      setPreviewOpen(false);
      setChatCollapsed(false);
    } else if (mode === "split") {
      setPreviewOpen(true);
      setChatCollapsed(false);
    } else {
      setPreviewOpen(true);
      setChatCollapsed(true);
    }
  }, []);
  const [dragging, setDragging] = useState(false);
  // Preview viewport (lifted here so the gutter drag can flip it to mobile at the
  // narrow edge); the preview's own toggles also drive it.
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /** Grow the tray with the prompt; thread keeps scroll for long chats. */
  function resizeComposer(el: HTMLTextAreaElement | null = inputRef.current) {
    if (!el) return;
    el.style.height = "0px";
    const cs = getComputedStyle(el);
    const max =
      parseFloat(cs.maxHeight) ||
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sindri-input-max")) ||
      192;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }
  const liveSeqRef = useRef(-1); // highest seq we've persisted into messages

  // ── loaders ─────────────────────────────────────────────────────────────────
  // Load Brokk Skills catalogue once (chip options).
  useEffect(() => {
    chat.listSkills()
      .then(setSkillOptions)
      .catch(() => setSkillOptions([]));
  }, []);

  // On environment change: load the project's sessions into the rail — and stop
  // there. The room opens with NO chat on the anvil (Claude Code / Cursor shape):
  // a session becomes active only when you pick one from the rail or start a new
  // one. Nothing is auto-opened, and an empty project no longer mints a session
  // just for landing on it.
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setSessionId("");
    setMessages([]);
    (async () => {
      const list = await chat.listSessions(projectId).catch(() => null);
      if (!active) return;
      setSessions(list ?? []);
    })();
    return () => {
      active = false;
    };
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
    liveSeqRef.current = -1;
    const { session, messages: msgs, running: live } = await chat.getSession(id);
    // Reflect the session's saved model + effort (all tiers are selectable now).
    setModel(
      isCursorEngine(normalizeEngineUi(session.engine))
        ? "auto"
        : MODELS.some((m) => m.id === session.model)
          ? session.model
          : "sonnet",
    );
    setEffort(session.effort && EFFORTS.some((e) => e.id === session.effort) ? session.effort : "medium");
    setEngine(normalizeEngineUi(session.engine));
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
    const s = await chat.createSession({
      projectId,
      model: isCursorEngine(engine) ? "auto" : model,
      effort,
      engine,
    });
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
    const raw = (textOverride ?? input).trim();
    if (!raw || !sid || running) return;
    const known = new Set(skillOptions.map((s) => s.name));
    const { skill: slashSkill, text } = extractSkillSlash(raw, known);
    if (!text) return;
    setInput("");
    setSlashOpen(false);
    requestAnimationFrame(() => resizeComposer());
    setError("");
    setLiveText("");
    setLiveThinking("");
    setRunning(true);
    setPhase("starting");
    if (slashSkill) {
      setSessions((prev) =>
        prev.map((s) => (s.id === sid ? { ...s, skill: slashSkill } : s)),
      );
    }
    // optimistic user bubble at the next seq
    upsert({ seq: liveSeqRef.current + 1, role: "user", blocks: [{ type: "text", text: raw }] });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await sendMessage(sid, text, handleEvent, ac.signal, slashSkill);
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

  async function removeSession(id: string, ev?: React.MouseEvent) {
    ev?.stopPropagation();
    const name = sessions.find((s) => s.id === id)?.title;
    if (!confirm(`This deletes ${name ? `"${name}"` : "the session"} and its transcript. Delete?`)) return;
    await chat.deleteSession(id).catch(() => {});
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (sessionId === id) {
      setSessionId("");
      setMessages([]);
    }
  }

  /** Rename any session (the rail edits rows in place, not just the open one). */
  async function renameSession(id: string, raw: string) {
    const t = raw.trim();
    if (!t || t === sessions.find((s) => s.id === id)?.title) return;
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: t } : s)));
    await chat.patchSession(id, { title: t }).catch(() => {});
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const filtered = slashFiltered;
    if (slashOpen && filtered.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActive((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActive((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const pick = filtered[slashActive];
        if (pick) applySlashSkill(pick.name);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const pick = filtered[slashActive];
        if (pick) applySlashSkill(pick.name);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const slashFiltered = useMemo(() => {
    const q = slashQuery.toLowerCase();
    return skillOptions.filter(
      (s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skillOptions, slashQuery]);

  function syncSlashFromInput(next: string, caret: number) {
    const before = next.slice(0, caret);
    const m = before.match(/(?:^|\s)\/([a-z0-9-]*)$/i);
    if (!m) {
      setSlashOpen(false);
      setSlashQuery("");
      return;
    }
    setSlashQuery(m[1]!.toLowerCase());
    setSlashOpen(true);
    setSlashActive(0);
  }

  function applySlashSkill(name: string) {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? input.length;
    const before = input.slice(0, caret);
    const after = input.slice(caret);
    const replaced = before.replace(/(?:^|\s)\/[a-z0-9-]*$/i, (m) => {
      const lead = m.startsWith(" ") || m.startsWith("\n") ? m[0]! : "";
      return `${lead}/${name} `;
    });
    const next = replaced + after;
    setInput(next);
    setSlashOpen(false);
    requestAnimationFrame(() => {
      const pos = replaced.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
      resizeComposer(el);
    });
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

  // Sessions newest-first — the order the ledger reads.
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

  /**
   * The context ring. Two different numbers hide behind the word "tokens":
   *   • what the session has SPENT — the sum of every turn's usage (`stats`), and
   *   • what the model is CARRYING right now — the last turn's input + cache read.
   * The ring can only mean the second one. Summing would sail past 100% on any
   * real session (a 44-message thread sums 212k against a 200k window while
   * actually carrying 14.5k), so the gauge would lie.
   */
  const context = useMemo(() => {
    let used = 0;
    for (const m of messages) {
      const u = (m.meta as { usage?: { inputTokens?: number; cacheReadTokens?: number } } | null)
        ?.usage;
      if (u) used = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0); // last wins, not summed
    }
    if (!used) return null; // cursor engines report no usage — no gauge, no guess
    return { used, window: CONTEXT_WINDOW };
  }, [messages]);

  // Token usage for the open session: aggregate from loaded messages, falling
  // back to the rail's stored aggregate.
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

      {/* ── room: session rail | (chat | live preview) ── */}
      <div className={`sindri-room ${railOpen ? "" : "is-railless"}`}>
        {railOpen ? (
          <SessionRail
            sessions={sortedSessions}
            currentId={sessionId}
            projectName={currentProject?.name ?? null}
            onOpen={(id) => void openSession(id)}
            onNew={() => void newChat()}
            onRemove={removeSession}
            onRename={(id, title) => void renameSession(id, title)}
            onCollapse={() => toggleRail(false)}
            disabled={!projectId}
          />
        ) : null}

      {!sessionId ? (
        <div className="sindri-body is-blank">
          <div className="sindri-blank">
            <Hammer className="sindri-blank-mark" size={56} strokeWidth={1.25} aria-hidden="true" />
            <h3>{currentProject ? `At the anvil with ${currentProject.name}` : "Pick an environment"}</h3>
            <p>
              Brokk clones the repo and works a branch of its own. Describe the first task
              to light the forge — the live preview opens beside it when you ask for it.
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
                placeholder={currentProject ? `What should Brokk forge in ${currentProject.name}?` : "Pick a project first"}
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
              ? { gridTemplateColumns: `minmax(0, ${split}fr) 1px minmax(0, ${1 - split}fr)` }
              : undefined
          }
        >
          {/* The head floats OVER the room, hugging the top-left — which in chat
              and split IS the top of the chat column, and in preview-full is the
              only door back. It spends no vertical band on chrome, and it is the
              single home of the window switch (the preview's own bar no longer
              carries one), so it must survive every layout. */}
          <header className="sindri-head">
            {/* With the rail folded away, its door lives here — NOT in the lintel:
                the verga is app chrome and would carry a control that means nothing
                in every other room. */}
            {!railOpen ? (
              <button
                type="button"
                className="sindri-head-rail"
                onClick={() => toggleRail(true)}
                title="Show sessions"
                aria-label="Show sessions"
              >
                <PanelLeftOpen size={15} />
              </button>
            ) : null}
            <div className="sindri-layoutswitch" role="group" aria-label="Layout">
              <button
                type="button"
                className={`sindri-preview-icon ${layout === "chat" ? "is-on" : ""}`}
                title="Chat em tela cheia"
                aria-pressed={layout === "chat"}
                onClick={() => setLayout("chat")}
              >
                <PanelLeft size={15} />
              </button>
              <button
                type="button"
                className={`sindri-preview-icon ${layout === "split" ? "is-on" : ""}`}
                title="Dividir chat e preview"
                aria-pressed={layout === "split"}
                onClick={() => setLayout("split")}
              >
                <Columns2 size={15} />
              </button>
              <button
                type="button"
                className={`sindri-preview-icon ${layout === "preview" ? "is-on" : ""}`}
                title="Preview em tela cheia"
                aria-pressed={layout === "preview"}
                onClick={() => setLayout("preview")}
              >
                <PanelRight size={15} />
              </button>
            </div>
          </header>

          {/* ── chat column ── */}
          {!chatCollapsed ? (
          <section className="sindri-chat">
            <>
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
                <div className="sindri-composer-stack">
                  <ComposerMenu
                    open={slashOpen}
                    items={slashFiltered.map((s) => ({
                      id: s.name,
                      label: `/${s.name}`,
                      hint: s.description,
                      tag: s.kind === "capability" ? "run" : "playbook",
                    }))}
                    activeIndex={slashActive}
                    onActiveIndex={setSlashActive}
                    onPick={applySlashSkill}
                    onClose={() => setSlashOpen(false)}
                    emptyHint={skillOptions.length ? "No skill matches" : "No skills loaded"}
                  />
                  <textarea
                    ref={inputRef}
                    className="sindri-input"
                    placeholder="Describe the work"
                    value={input}
                    onChange={(e) => {
                      const v = e.target.value;
                      setInput(v);
                      syncSlashFromInput(v, e.target.selectionStart ?? v.length);
                      resizeComposer(e.target);
                    }}
                    onInput={(e) => resizeComposer(e.currentTarget)}
                    onKeyDown={onKey}
                    onClick={(e) =>
                      syncSlashFromInput(input, (e.target as HTMLTextAreaElement).selectionStart)
                    }
                    rows={1}
                    disabled={running}
                  />
                  {/* Send/stop rides INSIDE the box, at the right edge — one
                      affordance where the sentence ends. */}
                  {running ? (
                    <button
                      type="button"
                      className="sindri-send is-stop"
                      onClick={stop}
                      title="Stop"
                      aria-label="Stop"
                    >
                      <Square size={14} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="sindri-send"
                      onClick={() => send()}
                      disabled={!input.trim()}
                      title="Send (Enter)"
                      aria-label="Send"
                    >
                      <CornerDownLeft size={14} />
                    </button>
                  )}
                </div>
                {currentSession?.skill ? (
                  <div className="sindri-skill-pin" title="Skill pinned for this session">
                    <span className="sindri-skill-pin-mark" aria-hidden="true" />
                    <code>/{currentSession.skill}</code>
                    <span className="sindri-skill-pin-lab">pinned</span>
                  </div>
                ) : null}
                <div className="sindri-cockpit">
                  {/* One row, right-aligned: what the session costs, and who runs it.
                      The anvil lives in the lintel and the branch in the session —
                      neither needs restating under every prompt. */}
                  <div className="sindri-cockpit-controls">
                    {context ? <ContextRing context={context} spent={tokens} /> : null}
                    {engine !== "claude-cli" && engine !== "cursor-cli" && (
                      <ComposerChip
                        title="Reasoning effort"
                        className="sindri-effort"
                        value={effort}
                        icon={<Zap size={13} />}
                        trigger={
                          <span className="sindri-bars" data-level={effort} aria-hidden="true">
                            <i />
                            <i />
                            <i />
                          </span>
                        }
                        items={EFFORTS.map((x) => ({ id: x.id, label: x.label }))}
                        onChange={(id) => {
                          setEffort(id);
                          if (sessionId) chat.patchSession(sessionId, { effort: id }).catch(() => {});
                        }}
                      />
                    )}
                    {isCursorEngine(engine) ? (
                      <span className="sindri-chip sindri-chip-static" title="Cursor always uses Auto">
                        Auto
                      </span>
                    ) : (
                      <ComposerChip
                        title="Model"
                        value={model}
                        items={MODELS.map((m) => ({ id: m.id, label: m.label }))}
                        onChange={(id) => {
                          setModel(id);
                          if (sessionId) chat.patchSession(sessionId, { model: id }).catch(() => {});
                        }}
                      />
                    )}
                    <ComposerChip
                      title="Motor (vale para novos chats)"
                      value={engine}
                      items={ENGINES.map((m) => ({
                        id: m.id,
                        label: m.label,
                        hint: m.hint,
                        tag: m.id.startsWith("cursor") ? "cursor" : "claude",
                      }))}
                      onChange={(id) => {
                        setEngine(id);
                        if (isCursorEngine(id)) setModel("auto");
                      }}
                    />
                  </div>
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
              device={device}
              setDevice={setDevice}
              mobileOnly={mobileOnly}
            />
          ) : null}
        </div>
      )}
      </div>
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
  device,
  setDevice,
  mobileOnly,
}: {
  sessionId: string;
  projectId: string;
  branch: string | null;
  sawEdit: boolean;
  device: "desktop" | "mobile";
  setDevice: (d: "desktop" | "mobile") => void;
  mobileOnly: boolean;
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
        const active = ps.find((x) => x.status === "starting" || x.status === "live") ?? null;
        setPreview(active);
        // Wake on entry: opening a project's Brokk screen boots its preview (once
        // per project) so it's warming while you read. The supervisor rests it
        // after PREVIEW_IDLE_TTL_MS idle; a `stopped` slot wakes via the effect
        // below, a never-booted project starts here.
        if (!active && autoTried.current !== projectId) {
          autoTried.current = projectId;
          void ensure();
        }
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, setDevice, mobileOnly, ensure]);

  // Idle-reaper heartbeat: while a preview is up and the operator is actually
  // interacting with the Brokk screen, ping (throttled 60s) so it stays warm.
  // No interaction (or the tab hidden/closed) → no pings → the supervisor rests
  // it after the TTL. `sawEdit` keeps the prop meaningful for a rested slot.
  useEffect(() => {
    const id = preview?.id;
    const status = preview?.status;
    if (!id || (status !== "live" && status !== "starting")) return;
    let last = 0;
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < 60_000) return;
      last = now;
      void brokk.pingPreview(id).catch(() => {});
    };
    beat();
    const evs: (keyof DocumentEventMap)[] = ["pointerdown", "keydown", "visibilitychange"];
    evs.forEach((e) => document.addEventListener(e, beat, { passive: true }));
    return () => evs.forEach((e) => document.removeEventListener(e, beat));
  }, [preview?.id, preview?.status]);

  // A fresh edit on a rested preview warms it back up (work resumed).
  useEffect(() => {
    if (sawEdit && preview?.status === "stopped" && !busy && projectId) {
      wokeFor.current = "";
      void ensure();
    }
  }, [sawEdit, preview?.status, busy, projectId, ensure]);

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
        {/* The layout switch lives in the chat's floating head — one switch, one
            home. In preview-full the chat column is gone, so the restore door is
            the collapse toggle further down this bar. */}
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
        {/* Session tokens moved to the composer cockpit: the composer is always on
            screen with a session open, the preview isn't. One readout, one home. */}
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
          <CommitControls projectId={projectId} sessionId={sessionId} nudge={sawEdit ? 1 : 0} />
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
                    It boots on Brokk&apos;s first edit — or start it now.
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
