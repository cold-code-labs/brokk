"use client";

// ─────────────────────────────────────────────────────────────────────────────
// SINDRI — the interactive chat agent. A per-project conversation that works the
// repo live (read/write/run, open cards + PRs) over the native Messages API.
//   • Left rail = project switcher + sessions grouped by recency, each card
//     carrying its own stats (volume + token spend).
//   • Right = a focused thread with an editable title, branch/model context, a
//     live stats strip, and markdown-rendered turns.
// Turns run server-side detached, so closing the tab doesn't stop Sindri.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { Banner, Button } from "@cold-code-labs/yggdrasil-react";
import {
  Plus,
  Send,
  Square,
  Hammer,
  Trash2,
  GitBranch,
  Search,
  Check,
  ChevronsUpDown,
  Pencil,
  MessageSquare,
  Zap,
  Cpu,
  Copy,
} from "lucide-react";
import { brokk } from "../lib/api";
import {
  attach,
  chat,
  sendMessage,
  type Block,
  type ChatMessage,
  type ChatSessionWithStats,
  type SindriEvent,
} from "../lib/chat";
import type { Project } from "@brokk/sdk";

const MODELS = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
];

const MODEL_LABEL: Record<string, string> = { sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" };

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

// Recency buckets for the session list, in display order.
const BUCKETS = ["Hoje", "Ontem", "7 dias", "Mais antigo"] as const;
function bucketOf(iso: string): (typeof BUCKETS)[number] {
  const then = new Date(iso);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = then.getTime();
  if (t >= startToday) return "Hoje";
  if (t >= startToday - 86_400_000) return "Ontem";
  if (t >= startToday - 7 * 86_400_000) return "7 dias";
  return "Mais antigo";
}

function sessionTime(s: ChatSessionWithStats): string {
  return s.stats.lastMessageAt || s.updatedAt;
}

export default function Chat() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [model, setModel] = useState("sonnet");
  const [sessions, setSessions] = useState<ChatSessionWithStats[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [phase, setPhase] = useState("");
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [projOpen, setProjOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const liveSeqRef = useRef(-1); // highest seq we've persisted into messages

  // ── loaders ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    brokk
      .listProjects()
      .then((p) => {
        setProjects(p);
        setProjectId((cur) => cur || p[0]?.id || "");
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    chat.listSessions(projectId).then(setSessions).catch(() => setSessions([]));
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
    (e: SindriEvent) => {
      switch (e.type) {
        case "text_delta":
          setLiveText((t) => t + e.text);
          break;
        case "message":
          upsert(e);
          if (e.role === "assistant") setLiveText("");
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
          // refresh stats for the session that just finished a turn
          if (projectId) chat.listSessions(projectId).then(setSessions).catch(() => {});
          break;
        default:
          break;
      }
    },
    [upsert, sessionId, projectId],
  );

  // Auto-scroll on new content.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, liveText, phase]);

  async function openSession(id: string) {
    abortRef.current?.abort();
    setSessionId(id);
    setMessages([]);
    setLiveText("");
    setError("");
    setRenaming(false);
    liveSeqRef.current = -1;
    const { session, messages: msgs, running: live } = await chat.getSession(id);
    setModel(session.model);
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
    const s = await chat.createSession({ projectId, model });
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

  // tool_use_id → result, for inline rendering.
  const results = useMemo(() => {
    const m = new Map<string, Block & { type: "tool_result" }>();
    for (const msg of messages)
      for (const b of msg.blocks) if (b.type === "tool_result") m.set(b.tool_use_id, b);
    return m;
  }, [messages]);

  const currentProject = projects.find((p) => p.id === projectId);
  const currentSession = sessions.find((s) => s.id === sessionId);

  // Filter + group sessions for the rail.
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
    const sorted = [...filtered].sort((a, b) => +new Date(sessionTime(b)) - +new Date(sessionTime(a)));
    const map = new Map<string, ChatSessionWithStats[]>();
    for (const s of sorted) {
      const k = bucketOf(sessionTime(s));
      (map.get(k) ?? map.set(k, []).get(k)!).push(s);
    }
    return BUCKETS.map((b) => [b, map.get(b) ?? []] as const).filter(([, arr]) => arr.length);
  }, [sessions, query]);

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
      <div className="sindri-grid">
        {/* ── session rail ── */}
        <aside className="sindri-rail">
          {/* project switcher */}
          <div className="sindri-proj">
            <button className="sindri-proj-btn" onClick={() => setProjOpen((o) => !o)}>
              <span className="sindri-proj-info">
                <span className="sindri-proj-name">{currentProject?.name ?? "Selecione um projeto"}</span>
                {currentProject ? <span className="sindri-proj-sub">{currentProject.baseBranch}</span> : null}
              </span>
              <ChevronsUpDown size={15} className="sindri-proj-caret" />
            </button>
            {projOpen ? (
              <>
                <div className="sindri-proj-scrim" onClick={() => setProjOpen(false)} />
                <div className="sindri-proj-menu">
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      className={`sindri-proj-item ${p.id === projectId ? "is-active" : ""}`}
                      onClick={() => {
                        setProjectId(p.id);
                        setProjOpen(false);
                        setSessionId("");
                        setMessages([]);
                      }}
                    >
                      <span className="sindri-proj-item-name">{p.name}</span>
                      {p.id === projectId ? <Check size={14} /> : null}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          <Button variant="default" onClick={newChat} disabled={!projectId} className="sindri-new">
            <Plus size={16} /> Novo chat
          </Button>

          {sessions.length > 3 ? (
            <div className="sindri-search">
              <Search size={14} />
              <input
                placeholder="Buscar conversas…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          ) : null}

          <div className="sindri-sessions">
            {sessions.length === 0 ? (
              <p className="sindri-empty">Sem conversas ainda neste projeto.</p>
            ) : grouped.length === 0 ? (
              <p className="sindri-empty">Nenhuma conversa encontrada.</p>
            ) : (
              grouped.map(([label, arr]) => (
                <div key={label} className="sindri-group">
                  <div className="sindri-group-label">{label}</div>
                  {arr.map((s) => (
                    <button
                      key={s.id}
                      className={`sindri-session ${s.id === sessionId ? "is-active" : ""}`}
                      onClick={() => openSession(s.id)}
                    >
                      <span className="sindri-session-top">
                        <span className="sindri-session-title">
                          {s.turnState === "running" ? <span className="sindri-dot" /> : null}
                          {s.title}
                        </span>
                        <Trash2 size={13} className="sindri-session-del" onClick={(e) => removeSession(s.id, e)} />
                      </span>
                      <span className="sindri-session-meta">
                        <span className="sindri-chip">{MODEL_LABEL[s.model] ?? s.model}</span>
                        {s.stats.messages > 0 ? (
                          <span className="sindri-meta-bit">
                            <MessageSquare size={11} /> {s.stats.messages}
                          </span>
                        ) : null}
                        {s.stats.tokensIn + s.stats.tokensOut > 0 ? (
                          <span className="sindri-meta-bit">
                            <Zap size={11} /> {fmtTokens(s.stats.tokensIn + s.stats.tokensOut)}
                          </span>
                        ) : null}
                        <span className="sindri-meta-time">{relTime(sessionTime(s))}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ── thread ── */}
        <section className="sindri-main">
          {error ? (
            <Banner tone="err" onClick={() => setError("")} style={{ cursor: "pointer" }}>
              {error}
            </Banner>
          ) : null}

          {!sessionId ? (
            <div className="sindri-blank">
              <div className="sindri-blank-mark">
                <Hammer size={34} strokeWidth={1.4} />
              </div>
              <h3>{currentProject ? `Trabalhe ${currentProject.name} com Sindri` : "Selecione um projeto"}</h3>
              <p>Abra um novo chat: ele clona o repositório e trabalha numa branch própria — lê, edita, roda, abre cards e PRs.</p>
              <Button variant="default" onClick={newChat} disabled={!projectId}>
                <Plus size={16} /> Novo chat
              </Button>
            </div>
          ) : (
            <>
              {/* session header */}
              <header className="sindri-head">
                <div className="sindri-head-main">
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
                      {currentSession?.title}
                      <button
                        className="sindri-title-edit"
                        title="Renomear"
                        onClick={() => {
                          setTitleDraft(currentSession?.title ?? "");
                          setRenaming(true);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                    </h2>
                  )}
                  <div className="sindri-head-ctx">
                    {currentSession?.branch ? (
                      <span className="sindri-ctx-bit sindri-ctx-branch">
                        <GitBranch size={12} /> {currentSession.branch}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="sindri-head-right">
                  <select
                    className="sindri-select"
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
                </div>
              </header>

              {/* stats strip */}
              <div className="sindri-stats">
                <span className="sindri-stat">
                  <MessageSquare size={13} /> {liveStats.turns} {liveStats.turns === 1 ? "pergunta" : "perguntas"}
                </span>
                <span className="sindri-stat">
                  <Cpu size={13} /> {MODEL_LABEL[currentSession?.model ?? model] ?? model}
                </span>
                <span className="sindri-stat">
                  <Zap size={13} /> {fmtTokens(liveStats.tokensIn)} in · {fmtTokens(liveStats.tokensOut)} out
                </span>
                <span className="sindri-stat sindri-stat-time">
                  atualizado {relTime(sessionTime(currentSession ?? ({} as ChatSessionWithStats)))}
                </span>
              </div>

              <div className="sindri-thread" ref={threadRef}>
                {messages.map((m) => (
                  <MessageView key={m.seq} message={m} results={results} />
                ))}
                {liveText ? (
                  <div className="sindri-msg is-assistant">
                    <div className="sindri-bubble">
                      <Markdown text={liveText} />
                    </div>
                  </div>
                ) : null}
                {running ? (
                  <div className="sindri-status">
                    <span className="sindri-spinner" /> {phase || "working"}…
                  </div>
                ) : null}
              </div>

              <div className="sindri-composer">
                <textarea
                  className="sindri-input"
                  placeholder="Peça algo ao Sindri…  (Enter envia, Shift+Enter quebra linha)"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKey}
                  rows={3}
                  disabled={running}
                />
                {running ? (
                  <Button variant="destructive" onClick={stop} className="sindri-send">
                    <Square size={16} /> Parar
                  </Button>
                ) : (
                  <Button variant="default" onClick={send} disabled={!input.trim()} className="sindri-send">
                    <Send size={16} /> Enviar
                  </Button>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
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

  const text = message.blocks
    .filter((b): b is Block & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const tools = message.blocks.filter((b): b is Block & { type: "tool_use" } => b.type === "tool_use");

  return (
    <div className={`sindri-msg ${message.role === "user" ? "is-user" : "is-assistant"}`}>
      <div className="sindri-bubble">
        {text ? (
          message.role === "user" ? <pre className="sindri-text">{text}</pre> : <Markdown text={text} />
        ) : null}
        {tools.map((t) => (
          <ToolCall key={t.id} tool={t} result={results.get(t.id)} />
        ))}
      </div>
    </div>
  );
}

function ToolCall({
  tool,
  result,
}: {
  tool: Block & { type: "tool_use" };
  result?: Block & { type: "tool_result" };
}) {
  const [open, setOpen] = useState(false);
  const arg =
    (tool.input.command as string) ||
    (tool.input.path as string) ||
    (tool.input.title as string) ||
    JSON.stringify(tool.input);
  return (
    <div className={`sindri-tool ${result?.is_error ? "is-error" : ""}`}>
      <button className="sindri-tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="sindri-tool-name">{tool.name}</span>
        <span className="sindri-tool-arg">{String(arg).slice(0, 90)}</span>
        {result ? <span className="sindri-tool-flag">{result.is_error ? "✗" : "✓"}</span> : <span className="sindri-spinner" />}
      </button>
      {open ? (
        <div className="sindri-tool-body">
          <div className="sindri-tool-label">input</div>
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

// ── lightweight markdown ──────────────────────────────────────────────────────
// Dependency-free: fenced code blocks, inline code, bold, headings, and lists.
// Enough to make assistant turns read well without pulling a markdown engine in.
function inline(s: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) nodes.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) nodes.push(<code key={`${keyBase}-${k++}`} className="sindri-icode">{tok.slice(1, -1)}</code>);
    else nodes.push(<strong key={`${keyBase}-${k++}`}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < s.length) nodes.push(s.slice(last));
  return nodes;
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="sindri-codeblock">
      <div className="sindri-codeblock-head">
        <span>{lang || "code"}</span>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(code).then(
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
      <pre className="sindri-pre">{code}</pre>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  // Split into fenced code blocks vs prose first.
  const segs: { type: "code" | "prose"; body: string; lang?: string }[] = [];
  const fence = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    if (m.index > last) segs.push({ type: "prose", body: text.slice(last, m.index) });
    segs.push({ type: "code", lang: m[1] || undefined, body: m[2] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: "prose", body: text.slice(last) });

  return (
    <div className="sindri-md">
      {segs.map((seg, i) =>
        seg.type === "code" ? (
          <CodeBlock key={i} code={seg.body.replace(/\n$/, "")} lang={seg.lang} />
        ) : (
          <Prose key={i} text={seg.body} />
        ),
      )}
    </div>
  );
}

function Prose({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  let key = 0;

  const flushPara = () => {
    if (para.length) {
      const body = para.join("\n");
      out.push(<p key={`p-${key++}`}>{inline(body, `p${key}`)}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((it, j) => <li key={j}>{inline(it, `li${key}-${j}`)}</li>);
      out.push(list.ordered ? <ol key={`l-${key++}`}>{items}</ol> : <ul key={`l-${key++}`}>{items}</ul>);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const level = Math.min(h[1].length + 2, 6);
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      out.push(<Tag key={`h-${key++}`} className="sindri-mdh">{inline(h[2], `h${key}`)}</Tag>);
    } else if (ul) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(ul[1]);
    } else if (ol) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ol[1]);
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return <>{out}</>;
}
