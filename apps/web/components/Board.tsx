"use client";

import type { Project, Run, RunEvent, Task } from "@brokk/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { brokk } from "../lib/api";

const COLUMNS = [
  { key: "backlog", label: "Backlog" },
  { key: "queued", label: "Queued" },
  { key: "running", label: "Running" },
  { key: "review", label: "Review · PR" },
  { key: "done", label: "Done" },
  { key: "failed", label: "Failed" },
] as const;

const STATUS_COLOR: Record<string, string> = {
  backlog: "#5c6575",
  queued: "#b08900",
  running: "#2f81f7",
  review: "#a371f7",
  done: "#2ea043",
  failed: "#f85149",
  cancelled: "#5c6575",
  succeeded: "#2ea043",
};

export default function Board() {
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Render only after mount: this is an interactive dashboard and browser
  // extensions (Dashlane etc.) mutate the form HTML before React hydrates,
  // which trips hydration warnings. Client-only sidesteps it cleanly.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const refresh = useCallback(async (projectId?: string) => {
    try {
      setTasks(await brokk.listTasks(projectId));
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  // Load the (first) project once, then poll tasks.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const projects = await brokk.listProjects();
        if (!alive) return;
        const p = projects[0] ?? null;
        setProject(p);
        await refresh(p?.id);
      } catch (e) {
        setErr(String(e));
      }
    })();
    const t = setInterval(() => refresh(project?.id), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, refresh]);

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    if (!project || !title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const task = await brokk.createTask({ projectId: project.id, title: title.trim(), body });
      await brokk.enqueueTask(task.id); // straight to the queue → a runner claims it
      setTitle("");
      setBody("");
      await refresh(project.id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function enqueue(id: string) {
    try {
      await brokk.enqueueTask(id);
      await refresh(project?.id);
    } catch (e) {
      setErr(String(e));
    }
  }

  const selectedTask = tasks.find((t) => t.id === selected) ?? null;

  if (!mounted) return null;

  return (
    <div style={{ padding: "28px 32px", maxWidth: 1400 }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, letterSpacing: -0.4 }}>Board</h1>
        <p style={{ margin: "4px 0 0", color: "#9aa3b2", fontSize: 14 }}>
          The forge — card → agent → PR.{" "}
          {project ? (
            <span style={{ color: "#e6e8ee" }}>{project.name}</span>
          ) : (
            <em>loading project…</em>
          )}
        </p>
      </header>

      <form onSubmit={createTask} style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New task title…"
          style={inp(280)}
        />
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Description (what the agent should do)…"
          style={inp(460)}
        />
        <button type="submit" disabled={busy || !project || !title.trim()} style={btn(true)}>
          {busy ? "Forging…" : "Queue task →"}
        </button>
      </form>

      {err && (
        <p style={{ color: "#f85149", fontSize: 13, margin: "0 0 12px" }}>⚠ {err}</p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(0,1fr))`, gap: 12 }}>
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.key);
          return (
            <section key={col.key} style={column}>
              <h2 style={colHead}>
                {col.label}
                <span style={{ color: "#5c6575", marginLeft: 6 }}>{items.length}</span>
              </h2>
              <div style={cardList}>
                {items.length === 0 && <p style={{ fontSize: 12, color: "#3f4654" }}>—</p>}
                {items.map((t) => (
                  <button key={t.id} onClick={() => setSelected(t.id)} style={card(selected === t.id)}>
                    <span style={{ ...dot, background: STATUS_COLOR[t.status] }} />
                    <span style={{ fontSize: 13, lineHeight: 1.3 }}>{t.title}</span>
                    {t.status === "backlog" && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          enqueue(t.id);
                        }}
                        style={miniBtn}
                      >
                        queue →
                      </span>
                    )}
                    {t.prUrl && (
                      <a href={t.prUrl} target="_blank" rel="noreferrer" style={prLink} onClick={(e) => e.stopPropagation()}>
                        PR ↗
                      </a>
                    )}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {selectedTask && <Detail task={selectedTask} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Detail({ task, onClose }: { task: Task; onClose: () => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // Load runs for the task; subscribe to the latest run's live stream.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    setEvents([]);
    (async () => {
      const rs = await brokk.listTaskRuns(task.id).catch(() => [] as Run[]);
      setRuns(rs);
      const latest = rs[0];
      if (latest) unsub = brokk.streamRunEvents(latest.id, (e) => setEvents((prev) => [...prev, e]));
    })();
    return () => unsub?.();
  }, [task.id]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events]);

  const latest = runs[0];

  return (
    <div style={overlay} onClick={onClose}>
      <aside style={drawer} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{task.title}</h2>
          <button onClick={onClose} style={btn(false)}>✕</button>
        </div>
        <div style={{ display: "flex", gap: 8, margin: "8px 0 14px", alignItems: "center", flexWrap: "wrap" }}>
          <Badge text={task.status} color={STATUS_COLOR[task.status]} />
          {latest && <Badge text={`run ${latest.status}`} color={STATUS_COLOR[latest.status]} />}
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer" style={{ ...prLink, position: "static" }}>
              Open PR ↗
            </a>
          )}
        </div>
        {task.body && <p style={{ color: "#aab2c0", fontSize: 13, whiteSpace: "pre-wrap" }}>{task.body}</p>}
        {latest?.error && (
          <pre style={{ ...logBox, color: "#f85149", maxHeight: 120 }}>{latest.error}</pre>
        )}

        <h3 style={{ fontSize: 12, textTransform: "uppercase", color: "#9aa3b2", margin: "16px 0 6px" }}>
          Live run log{latest ? ` · ${latest.id.slice(0, 8)}` : ""}
        </h3>
        <div ref={logRef} style={logBox}>
          {events.length === 0 && <span style={{ color: "#3f4654" }}>no events yet…</span>}
          {events.map((e, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              <span style={{ color: STATUS_COLOR[e.type] ?? "#5c6575", fontWeight: 600 }}>{e.type}</span>{" "}
              <span style={{ color: "#8b94a3" }}>{summarize(e)}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function summarize(e: RunEvent): string {
  const p = e.payload as any;
  if (e.type === "status") return p?.phase ?? JSON.stringify(p);
  if (e.type === "usage") return `in ${p?.input_tokens ?? "?"} / out ${p?.output_tokens ?? "?"}`;
  if (e.type === "message") {
    const c = p?.message?.content ?? p?.content;
    if (Array.isArray(c)) {
      const text = c.map((b: any) => b?.text ?? (b?.type ? `[${b.type}]` : "")).join(" ").trim();
      return text.slice(0, 200) || "[message]";
    }
    return "[message]";
  }
  const s = JSON.stringify(p);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

function Badge({ text, color }: { text: string; color?: string }) {
  return (
    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: "#1a1f29", color: color ?? "#9aa3b2", border: `1px solid ${color ?? "#2a2f3a"}33` }}>
      {text}
    </span>
  );
}

// ── inline styles ─────────────────────────────────────────────────────────────
const column: React.CSSProperties = { background: "#0f121a", border: "1px solid #1c212c", borderRadius: 10, padding: 10, display: "flex", flexDirection: "column" };
const cardList: React.CSSProperties = { maxHeight: 320, overflowY: "auto", overflowX: "hidden" };
const colHead: React.CSSProperties = { fontSize: 12, textTransform: "uppercase", color: "#9aa3b2", margin: "0 0 10px", letterSpacing: 0.4 };
const dot: React.CSSProperties = { width: 7, height: 7, borderRadius: 7, flexShrink: 0, marginTop: 5 };
const prLink: React.CSSProperties = { position: "absolute", right: 8, bottom: 6, fontSize: 11, color: "#a371f7", textDecoration: "none" };
const miniBtn: React.CSSProperties = { position: "absolute", right: 8, top: 8, fontSize: 10, color: "#b08900", border: "1px solid #b0890044", borderRadius: 6, padding: "1px 6px" };
const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "flex-end", zIndex: 50 };
const drawer: React.CSSProperties = { width: "min(560px, 100%)", height: "100%", background: "#0d1017", borderLeft: "1px solid #1c212c", padding: 22, overflowY: "auto", boxShadow: "-20px 0 60px rgba(0,0,0,0.4)" };
const logBox: React.CSSProperties = { background: "#08090d", border: "1px solid #1c212c", borderRadius: 8, padding: 10, fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11.5, lineHeight: 1.45, maxHeight: 360, overflowY: "auto", whiteSpace: "pre-wrap" };

function card(active: boolean): React.CSSProperties {
  return { position: "relative", display: "flex", gap: 7, alignItems: "start", width: "100%", textAlign: "left", background: active ? "#1a2030" : "#141823", border: `1px solid ${active ? "#2f81f7" : "#222836"}`, borderRadius: 8, padding: "9px 10px 18px", marginBottom: 8, color: "#e6e8ee", cursor: "pointer" };
}
function inp(w: number): React.CSSProperties {
  return { flex: `1 1 ${w}px`, minWidth: 160, background: "#0f121a", border: "1px solid #222836", borderRadius: 8, padding: "9px 11px", color: "#e6e8ee", fontSize: 13 };
}
function btn(primary: boolean): React.CSSProperties {
  return { background: primary ? "#2f81f7" : "#1a1f29", border: "1px solid #2a2f3a", color: primary ? "#fff" : "#9aa3b2", borderRadius: 8, padding: "9px 14px", fontSize: 13, cursor: "pointer" };
}
