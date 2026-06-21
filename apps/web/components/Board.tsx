"use client";

import type { Preview, Project, Run, RunEvent, Task } from "@brokk/sdk";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { brokk } from "../lib/api";
import { STATUS_COLOR, STATUS_LABEL, t } from "../lib/theme";
import { PreviewChip } from "./PreviewChip";

const COLUMNS = ["backlog", "queued", "running", "review", "done", "failed"] as const;

/** Board for a single project. `projectId` selects the repo's board; when omitted
 *  it falls back to the first project (legacy single-project entry). */
export default function Board({ projectId }: { projectId?: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Render only after mount: browser extensions (Dashlane etc.) mutate form HTML
  // before React hydrates, which trips hydration warnings. Client-only sidesteps it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const refresh = useCallback(async (pid?: string) => {
    if (!pid) return;
    try {
      setTasks(await brokk.listTasks(pid));
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const projects = await brokk.listProjects();
        if (!alive) return;
        const p = (projectId ? projects.find((x) => x.id === projectId) : projects[0]) ?? null;
        setProject(p);
        await refresh(p?.id);
      } catch (e) {
        setErr(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, refresh]);

  useEffect(() => {
    if (!project?.id) return;
    const i = setInterval(() => refresh(project.id), 3000);
    return () => clearInterval(i);
  }, [project?.id, refresh]);

  // Load the most-recent active preview when the project becomes known.
  useEffect(() => {
    if (!project?.id) return;
    brokk
      .listPreviews(project.id)
      .then((ps) => {
        const active = ps.find((x) => x.status === "starting" || x.status === "live");
        setPreview(active ?? null);
      })
      .catch(() => {});
  }, [project?.id]);

  // Poll the preview status every 2 s while it is still starting.
  const previewId = preview?.id;
  const previewStatus = preview?.status;
  useEffect(() => {
    if (!previewId || previewStatus !== "starting") return;
    const id = previewId;
    const i = setInterval(() => {
      brokk.getPreview(id).then(setPreview).catch(() => {});
    }, 2000);
    return () => clearInterval(i);
  }, [previewId, previewStatus]);

  async function handlePreview() {
    if (!project) return;
    setPreviewBusy(true);
    setPreviewErr(null);
    try {
      const pv = await brokk.createPreview({ projectId: project.id });
      setPreview(pv);
    } catch (e) {
      setPreviewErr(String(e));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function handleStopPreview() {
    if (!preview) return;
    // Failed previews are just dismissed locally; live/starting ones are stopped via API.
    if (preview.status === "failed") {
      setPreview(null);
      return;
    }
    try {
      await brokk.stopPreview(preview.id);
      setPreview(null);
    } catch (e) {
      setPreviewErr(String(e));
    }
  }

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    if (!project || !title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const task = await brokk.createTask({ projectId: project.id, title: title.trim(), body });
      await brokk.enqueueTask(task.id);
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

  const selectedTask = tasks.find((x) => x.id === selected) ?? null;
  if (!mounted) return null;

  return (
    <div style={{ padding: "28px 32px", maxWidth: 1500 }}>
      <header style={{ marginBottom: 20 }}>
        <Link href="/" style={{ fontSize: 12, color: t.textMuted, textDecoration: "none" }}>
          ← Fleet
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 6 }}>
          <h1 style={{ margin: 0, fontSize: 22, letterSpacing: -0.4 }}>
            {project ? project.name : "Board"}
          </h1>
          {project && (
            preview && preview.status !== "stopped" ? (
              <PreviewChip preview={preview} onStop={handleStopPreview} />
            ) : (
              <button
                type="button"
                onClick={handlePreview}
                disabled={previewBusy}
                style={previewBtnBoard}
              >
                {previewBusy ? "starting…" : "Preview dev"}
              </button>
            )
          )}
        </div>
        <p style={{ margin: "4px 0 0", color: t.textMuted, fontSize: 14 }}>
          The forge — card → agent → PR.{" "}
          {project && <span style={{ color: t.textFaint }}>model {project.model}</span>}
        </p>
      </header>

      <form onSubmit={createTask} style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task title…" style={inp(280)} />
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="What the agent should do…" style={inp(460)} />
        <button type="submit" disabled={busy || !project || !title.trim()} style={btn(true)}>
          {busy ? "Forging…" : "Queue task →"}
        </button>
      </form>

      {err && <p style={{ color: STATUS_COLOR.failed, fontSize: 13, margin: "0 0 12px" }}>⚠ {err}</p>}
      {previewErr && <p style={{ color: STATUS_COLOR.failed, fontSize: 13, margin: "0 0 12px" }}>⚠ preview: {previewErr}</p>}

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(0,1fr))`, gap: 12 }}>
        {COLUMNS.map((key) => {
          const items = tasks.filter((x) => x.status === key);
          return (
            <section key={key} style={column}>
              <h2 style={colHead}>
                {STATUS_LABEL[key]}
                <span style={{ color: t.textFaint, marginLeft: 6 }}>{items.length}</span>
              </h2>
              <div style={cardList}>
                {items.length === 0 && <p style={{ fontSize: 12, color: t.textFaint }}>—</p>}
                {items.map((task) => (
                  <button key={task.id} onClick={() => setSelected(task.id)} style={card(selected === task.id)}>
                    <span style={{ display: "flex", gap: 7, alignItems: "start" }}>
                      <span style={{ ...dot, background: STATUS_COLOR[task.status] }} />
                      <span style={{ fontSize: 13, lineHeight: 1.3 }}>{task.title}</span>
                    </span>
                    {(task.status === "backlog" || task.prUrl) && (
                      <span style={cardFooter}>
                        {task.status === "backlog" && (
                          <span onClick={(e) => { e.stopPropagation(); enqueue(task.id); }} style={miniBtn}>
                            queue →
                          </span>
                        )}
                        {task.prUrl && (
                          <a href={task.prUrl} target="_blank" rel="noreferrer" style={prLink} onClick={(e) => e.stopPropagation()}>
                            PR ↗
                          </a>
                        )}
                      </span>
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
        {task.body && <p style={{ color: t.textMuted, fontSize: 13, whiteSpace: "pre-wrap" }}>{task.body}</p>}
        {latest?.error && <pre style={{ ...logBox, color: STATUS_COLOR.failed, maxHeight: 120 }}>{latest.error}</pre>}

        <h3 style={{ fontSize: 12, textTransform: "uppercase", color: t.textMuted, margin: "16px 0 6px" }}>
          Live run log{latest ? ` · ${latest.id.slice(0, 8)}` : ""}
        </h3>
        <div ref={logRef} style={logBox}>
          {events.length === 0 && <span style={{ color: t.textFaint }}>no events yet…</span>}
          {events.map((e, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              <span style={{ color: STATUS_COLOR[e.type] ?? t.textFaint, fontWeight: 600 }}>{e.type}</span>{" "}
              <span style={{ color: t.textMuted }}>{summarize(e)}</span>
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
    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: t.surface3, color: color ?? t.textMuted, border: `1px solid ${color ?? t.border2}33` }}>
      {text}
    </span>
  );
}

const column: React.CSSProperties = { background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", minHeight: 0 };
const cardList: React.CSSProperties = { flex: "1 1 auto", minHeight: 0, maxHeight: 320, overflowY: "auto", overflowX: "hidden" };
const colHead: React.CSSProperties = { fontSize: 12, textTransform: "uppercase", color: t.textMuted, margin: "0 0 10px", letterSpacing: 0.4 };
const dot: React.CSSProperties = { width: 7, height: 7, borderRadius: 7, flexShrink: 0, marginTop: 5 };
const cardFooter: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8, alignItems: "center" };
const prLink: React.CSSProperties = { fontSize: 11, color: t.purple, textDecoration: "none" };
const miniBtn: React.CSSProperties = { fontSize: 11, color: STATUS_COLOR.queued, border: `1px solid ${STATUS_COLOR.queued}44`, borderRadius: 6, padding: "2px 8px" };
const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "flex-end", zIndex: 50 };
const drawer: React.CSSProperties = { width: "min(560px, 100%)", height: "100%", background: t.bg, borderLeft: `1px solid ${t.border}`, padding: 22, overflowY: "auto", boxShadow: "-20px 0 60px rgba(0,0,0,0.4)" };
const logBox: React.CSSProperties = { background: t.inset, border: `1px solid ${t.border}`, borderRadius: 8, padding: 10, fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11.5, lineHeight: 1.45, maxHeight: 360, overflowY: "auto", whiteSpace: "pre-wrap" };

const previewBtnBoard: React.CSSProperties = { fontSize: 12, color: t.accent, background: t.surface3, border: `1px solid ${t.border2}`, borderRadius: 20, padding: "4px 12px", cursor: "pointer" };

function card(active: boolean): React.CSSProperties {
  return { display: "flex", flexDirection: "column", width: "100%", textAlign: "left", background: active ? t.surface3 : t.surface2, border: `1px solid ${active ? t.borderActive : t.border2}`, borderRadius: 8, padding: "9px 10px", marginBottom: 8, color: t.text, cursor: "pointer" };
}
function inp(w: number): React.CSSProperties {
  return { flex: `1 1 ${w}px`, minWidth: 160, background: t.surface, border: `1px solid ${t.border2}`, borderRadius: 8, padding: "9px 11px", color: t.text, fontSize: 13 };
}
function btn(primary: boolean): React.CSSProperties {
  return { background: primary ? t.accent : t.surface3, border: `1px solid ${t.border2}`, color: primary ? "#fff" : t.textMuted, borderRadius: 8, padding: "9px 14px", fontSize: 13, cursor: "pointer" };
}
