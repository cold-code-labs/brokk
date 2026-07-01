"use client";

import type { Preview, Project, Run, RunEvent, Task } from "@brokk/sdk";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Main,
  PageHeader,
  Banner,
  Button,
} from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { useProject } from "../lib/project-context";
import { STATUS_COLOR, STATUS_LABEL, t } from "../lib/theme";
import { AgentAvatar } from "./AgentAvatar";
import { PreviewChip } from "./PreviewChip";

const COLUMNS = ["backlog", "queued", "running", "review", "done", "failed"] as const;

/** Status → Yggdrasil badge tone (the four supported tones). */
const STATUS_TONE: Record<string, "ok" | "warn" | "err" | "info" | undefined> = {
  queued: "warn",
  running: "info",
  review: "info",
  done: "ok",
  succeeded: "ok",
  failed: "err",
};

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

  // Viewing a board IS selecting that environment — keep the global switcher
  // (and every other project-scoped page) in sync with the board you opened.
  const { setCurrentId } = useProject();
  useEffect(() => {
    if (projectId) setCurrentId(projectId);
  }, [projectId, setCurrentId]);

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
    <Main style={{ maxWidth: "94rem" }}>
      <PageHeader
        title={project ? project.name : "Board"}
        description={
          <>
            The forge — card → agent → PR.{" "}
            {project && <span className="ygg-dim">model {project.model}</span>}
          </>
        }
        actions={
          project &&
          (preview && preview.status !== "stopped" ? (
            <PreviewChip preview={preview} onStop={handleStopPreview} />
          ) : (
            <Button variant="outline" size="sm" type="button" onClick={handlePreview} disabled={previewBusy}>
              {previewBusy ? "starting…" : "Preview dev"}
            </Button>
          ))
        }
      >
        <Link href="/" className="ygg-dim" style={{ fontSize: 12, textDecoration: "none", display: "inline-block", marginBottom: 6 }}>
          ← Fleet
        </Link>
      </PageHeader>

      <form onSubmit={createTask} style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task title…" style={{ ...field, flex: "1 1 280px" }} />
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="What the agent should do…" style={{ ...field, flex: "1 1 460px" }} />
        <Button type="submit" disabled={busy || !project || !title.trim()}>
          {busy ? "Forging…" : "Queue task →"}
        </Button>
      </form>

      {err && <Banner tone="err">⚠ {err}</Banner>}
      {previewErr && <Banner tone="err">⚠ preview: {previewErr}</Banner>}

      <div style={boardScroll}>
        {COLUMNS.map((key) => {
          const items = tasks.filter((x) => x.status === key);
          return (
            <section key={key} style={column}>
              <h2 style={colHead}>
                {STATUS_LABEL[key]}
                <span style={{ color: "var(--fg-dim)", marginLeft: 6 }}>{items.length}</span>
              </h2>
              <div style={cardList}>
                {items.length === 0 && <p className="ygg-dim" style={{ fontSize: 12, margin: 0 }}>—</p>}
                {items.map((task) => (
                  <button key={task.id} onClick={() => setSelected(task.id)} style={card(selected === task.id)}>
                    <span style={{ display: "flex", gap: 7, alignItems: "start", justifyContent: "space-between" }}>
                      <span style={{ display: "flex", gap: 7, alignItems: "start", minWidth: 0, flex: 1 }}>
                        <span style={{ ...dot, background: STATUS_COLOR[task.status] }} />
                        <span style={cardTitle}>{task.title}</span>
                      </span>
                      {/* who created this card — agent or you */}
                      <AgentAvatar createdBy={task.createdBy} size={17} />
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
    </Main>
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
          <Button variant="outline" size="icon" onClick={onClose} aria-label="Close">✕</Button>
        </div>
        <div style={{ display: "flex", gap: 8, margin: "8px 0 14px", alignItems: "center", flexWrap: "wrap" }}>
          <span className="ygg-badge" data-tone={STATUS_TONE[task.status]}>{task.status}</span>
          {latest && <span className="ygg-badge" data-tone={STATUS_TONE[latest.status]}>run {latest.status}</span>}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg-dim)" }}>
            por <AgentAvatar createdBy={task.createdBy} size={18} showLabel />
          </span>
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer" style={{ ...prLink, position: "static" }}>
              Open PR ↗
            </a>
          )}
        </div>
        {task.body && <p className="ygg-muted" style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{task.body}</p>}
        {latest?.error && <pre style={{ ...logBox, color: STATUS_COLOR.failed, maxHeight: 120 }}>{latest.error}</pre>}

        <h3 className="ygg-muted" style={{ fontSize: 12, textTransform: "uppercase", margin: "16px 0 6px" }}>
          Live run log{latest ? ` · ${latest.id.slice(0, 8)}` : ""}
        </h3>
        <div ref={logRef} style={logBox}>
          {events.length === 0 && <span className="ygg-dim">no events yet…</span>}
          {events.map((e, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              <span style={{ color: STATUS_COLOR[e.type] ?? "var(--fg-dim)", fontWeight: 600 }}>{e.type}</span>{" "}
              <span className="ygg-muted">{summarize(e)}</span>
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

const field: React.CSSProperties = {
  background: "var(--bg-soft)",
  border: "1px solid var(--line)",
  borderRadius: "0.55rem",
  padding: "0.55rem 0.7rem",
  color: "var(--fg)",
  font: "inherit",
  fontSize: "0.9rem",
  minWidth: 160,
};

// Board: fixed-width columns + horizontal scroll (standard kanban). Fixed width
// keeps cards readable regardless of column count and accommodates new columns
// (e.g. Analysis) without squeezing the rest.
const boardScroll: React.CSSProperties = { display: "flex", gap: 14, overflowX: "auto", overflowY: "hidden", paddingBottom: 10, scrollSnapType: "x proximity" };
const column: React.CSSProperties = { flex: "0 0 300px", scrollSnapAlign: "start", background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", minHeight: 0 };
const cardList: React.CSSProperties = { flex: "1 1 auto", minHeight: 0, maxHeight: "min(62vh, 640px)", overflowY: "auto", overflowX: "hidden", paddingRight: 2 };
const colHead: React.CSSProperties = { fontSize: 12, textTransform: "uppercase", color: t.textMuted, margin: "0 0 12px", letterSpacing: 0.4 };
// Title clamped to 3 lines — long ajuste titles no longer eat the whole column.
const cardTitle: React.CSSProperties = { fontSize: 13.5, lineHeight: 1.35, minWidth: 0, wordBreak: "break-word", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" };
const dot: React.CSSProperties = { width: 7, height: 7, borderRadius: 7, flexShrink: 0, marginTop: 5 };
const cardFooter: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8, alignItems: "center" };
const prLink: React.CSSProperties = { fontSize: 11, color: t.purple, textDecoration: "none" };
const miniBtn: React.CSSProperties = { fontSize: 11, color: STATUS_COLOR.queued, border: `1px solid ${STATUS_COLOR.queued}44`, borderRadius: 6, padding: "2px 8px" };
const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "flex-end", zIndex: 50 };
const drawer: React.CSSProperties = { width: "min(560px, 100%)", height: "100%", background: t.bg, borderLeft: `1px solid ${t.border}`, padding: 22, overflowY: "auto", boxShadow: "-20px 0 60px rgba(0,0,0,0.4)" };
const logBox: React.CSSProperties = { background: t.inset, border: `1px solid ${t.border}`, borderRadius: 8, padding: 10, fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11.5, lineHeight: 1.45, maxHeight: 360, overflowY: "auto", whiteSpace: "pre-wrap" };

function card(active: boolean): React.CSSProperties {
  return { display: "flex", flexDirection: "column", width: "100%", textAlign: "left", background: active ? t.surface3 : t.surface2, border: `1px solid ${active ? t.borderActive : t.border2}`, borderRadius: 8, padding: "11px 12px", marginBottom: 9, color: t.text, cursor: "pointer" };
}
