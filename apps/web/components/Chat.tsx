"use client";

// ─────────────────────────────────────────────────────────────────────────────
// SINDRI — the interactive chat agent. A per-project conversation that works the
// repo live (read/write/run, open cards + PRs) over the native Messages API. Left
// rail = project + session history; right = the streaming thread. Turns run
// server-side detached, so closing the tab doesn't stop Sindri (overnight).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { Banner, Button, PageHeader } from "@cold-code-labs/yggdrasil-react";
import { Plus, Send, Square, Hammer, Trash2, GitBranch } from "lucide-react";
import { brokk } from "../lib/api";
import {
  attach,
  chat,
  sendMessage,
  type Block,
  type ChatMessage,
  type ChatSession,
  type SindriEvent,
} from "../lib/chat";
import type { Project } from "@brokk/sdk";

const MODELS = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
];

export default function Chat() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [model, setModel] = useState("sonnet");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [phase, setPhase] = useState("");
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

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
          break;
        default:
          break;
      }
    },
    [upsert, sessionId],
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
    setSessions((prev) => [s, ...prev]);
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
    if (!confirm("Delete this chat?")) return;
    await chat.deleteSession(id).catch(() => {});
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (sessionId === id) {
      setSessionId("");
      setMessages([]);
    }
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

  return (
    <main className="sindri">
      <PageHeader
        title="Sindri"
        description="Trabalhe o repositório em conversa — lê, edita, roda, abre cards e PRs."
        actions={
          <div className="sindri-controls">
            <select className="sindri-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select className="sindri-select" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        }
      />

      {error ? (
        <Banner tone="err" onClick={() => setError("")} style={{ cursor: "pointer" }}>
          {error}
        </Banner>
      ) : null}

      <div className="sindri-grid">
        {/* ── session rail ── */}
        <aside className="sindri-rail">
          <Button variant="default" onClick={newChat} disabled={!projectId} className="sindri-new">
            <Plus size={16} /> Novo chat
          </Button>
          <div className="sindri-sessions">
            {sessions.length === 0 ? (
              <p className="sindri-empty">Sem conversas ainda neste projeto.</p>
            ) : (
              sessions.map((s) => (
                <button
                  key={s.id}
                  className={`sindri-session ${s.id === sessionId ? "is-active" : ""}`}
                  onClick={() => openSession(s.id)}
                >
                  <span className="sindri-session-title">
                    {s.turnState === "running" ? <span className="sindri-dot" /> : null}
                    {s.title}
                  </span>
                  <Trash2 size={14} className="sindri-session-del" onClick={(e) => removeSession(s.id, e)} />
                </button>
              ))
            )}
          </div>
        </aside>

        {/* ── thread ── */}
        <section className="sindri-main">
          {!sessionId ? (
            <div className="sindri-blank">
              <Hammer size={40} strokeWidth={1.4} />
              <h3>{currentProject ? `Trabalhe ${currentProject.name} com Sindri` : "Selecione um projeto"}</h3>
              <p>Abra um novo chat: ele clona o repositório e trabalha numa branch própria.</p>
              <Button variant="default" onClick={newChat} disabled={!projectId}>
                <Plus size={16} /> Novo chat
              </Button>
            </div>
          ) : (
            <>
              {currentSession?.branch ? (
                <div className="sindri-branchbar">
                  <GitBranch size={13} /> {currentSession.branch}
                </div>
              ) : null}
              <div className="sindri-thread" ref={threadRef}>
                {messages.map((m) => (
                  <MessageView key={m.seq} message={m} results={results} />
                ))}
                {liveText ? (
                  <div className="sindri-msg is-assistant">
                    <div className="sindri-bubble">
                      <pre className="sindri-text">{liveText}</pre>
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
        {text ? <pre className="sindri-text">{text}</pre> : null}
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
