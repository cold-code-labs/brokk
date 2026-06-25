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
import { discovery, type ProjectBrief } from "../lib/chat";
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

      {project && (
        <BriefPanel
          projectId={project.id}
          proposedCount={
            tasks.filter(
              (t) => t.status === "backlog" && (t.labels ?? []).some((l) => l === "discovery" || l === "plan"),
            ).length
          }
          onApproved={() => refresh(project.id)}
        />
      )}

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(0,1fr))`, gap: 12 }}>
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
                      <span style={{ display: "flex", gap: 7, alignItems: "start", minWidth: 0 }}>
                        <span style={{ ...dot, background: STATUS_COLOR[task.status] }} />
                        <span style={{ fontSize: 13, lineHeight: 1.3 }}>{task.title}</span>
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

/** Huginn's discovery brief for the project: what it IS, what's BUILT, what's
 *  MISSING. Phase 1 = read-only display + re-scout; the "missing" items become
 *  proposed plan-cards in Phase 2. Polls while a scout is in flight. */
function BriefPanel({
  projectId,
  proposedCount,
  onApproved,
}: {
  projectId: string;
  proposedCount: number;
  onApproved: () => void;
}) {
  const [brief, setBrief] = useState<ProjectBrief | null>(null);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [appBusy, setAppBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await discovery.get(projectId);
      setBrief(r.brief);
      setRunning(r.running || r.brief?.status === "pending");
    } catch {
      /* brief stays as-is */
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    setLoaded(false);
    load();
  }, [load]);

  // Poll while a scout is running (or the brief is pending).
  useEffect(() => {
    if (!running) return;
    const i = setInterval(load, 4000);
    return () => clearInterval(i);
  }, [running, load]);

  async function rescout() {
    try {
      await discovery.scout(projectId);
      setRunning(true);
      setBrief((b) => (b ? { ...b, status: "pending" } : b));
    } catch {
      /* ignore */
    }
  }

  // Phase 3: approve ALL proposed cards at once (backlog → queued).
  async function approveAll() {
    setAppBusy(true);
    setGenMsg(null);
    try {
      const { enqueued } = await brokk.approveProposed(projectId);
      onApproved();
      setGenMsg(
        enqueued ? `${enqueued} card(s) enfileirado(s) — a forja vai começar.` : "Nada proposto para aprovar.",
      );
    } catch (e) {
      setGenMsg(`Erro: ${String(e)}`);
    } finally {
      setAppBusy(false);
    }
  }

  // Phase 2: materialize the brief's "missing" items as proposed backlog cards.
  // They land in the Backlog column; approve each with the existing "queue →".
  async function generateBacklog() {
    setGenBusy(true);
    setGenMsg(null);
    try {
      const { created, skipped } = await brokk.backlogFromBrief(projectId);
      setGenMsg(
        created.length
          ? `${created.length} card${created.length > 1 ? "s" : ""} no backlog${skipped ? ` · ${skipped} já existiam` : ""} — aprove com “queue →”.`
          : skipped
            ? `Todos os ${skipped} itens já viraram cards.`
            : "Nada para gerar.",
      );
    } catch (e) {
      setGenMsg(`Erro: ${String(e)}`);
    } finally {
      setGenBusy(false);
    }
  }

  if (!loaded) return null;

  const status = running ? "pending" : brief?.status;

  return (
    <section style={brief_panel}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: open ? 12 : 0 }}>
        <button onClick={() => setOpen((o) => !o)} style={briefToggle} title={open ? "recolher" : "expandir"}>
          {open ? "▾" : "▸"}
        </button>
        <span style={{ fontWeight: 600, fontSize: 14 }}>🪶 Huginn — descoberta do projeto</span>
        {status === "pending" && <span className="ygg-dim" style={{ fontSize: 12 }}>explorando o repositório…</span>}
        {status === "failed" && <span style={{ fontSize: 12, color: "var(--err, #f85149)" }}>falhou</span>}
        <span style={{ marginLeft: "auto" }} />
        {proposedCount > 0 && (
          <Button type="button" size="sm" onClick={approveAll} disabled={appBusy}>
            {appBusy ? "Enfileirando…" : `Aprovar todos (${proposedCount})`}
          </Button>
        )}
        <Button variant="outline" size="sm" type="button" onClick={rescout} disabled={status === "pending"}>
          {status === "pending" ? "escaneando…" : brief ? "Re-escanear" : "Escanear"}
        </Button>
      </div>

      {open && (
        <>
          {!brief && status !== "pending" && (
            <p className="ygg-dim" style={{ fontSize: 13, margin: 0 }}>
              Ainda não escaneado. Clique em “Escanear” para o Huginn ler o projeto e propor um backlog.
            </p>
          )}
          {status === "failed" && brief?.error && (
            <p style={{ fontSize: 12, color: "var(--err, #f85149)", margin: "4px 0 0" }}>{brief.error}</p>
          )}
          {brief?.status === "ready" && (
            <div style={{ display: "grid", gap: 14 }}>
              {brief.mission && (
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{brief.mission}</p>
              )}
              {brief.summary && (
                <p className="ygg-dim" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>{brief.summary}</p>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <BriefList title="✅ Construído" items={brief.built} />
                <BriefList title="🧭 Faltando / próximos passos" items={brief.missing} accent />
              </div>
              {brief.stack.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="ygg-dim" style={{ fontSize: 12 }}>stack:</span>
                  {brief.stack.map((s) => (
                    <span key={s} style={stackChip}>{s}</span>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <Button
                  type="button"
                  size="sm"
                  onClick={generateBacklog}
                  disabled={genBusy || brief.missing.length === 0}
                >
                  {genBusy ? "Gerando…" : `Gerar cards do backlog (${brief.missing.length})`}
                </Button>
                {genMsg && <span className="ygg-dim" style={{ fontSize: 12 }}>{genMsg}</span>}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function BriefList({ title, items, accent }: { title: string; items: string[]; accent?: boolean }) {
  return (
    <div>
      <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--fg-dim)", margin: "0 0 8px" }}>
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="ygg-dim" style={{ fontSize: 12, margin: 0 }}>—</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {items.map((it, i) => (
            <li
              key={i}
              style={{
                fontSize: 13,
                lineHeight: 1.4,
                padding: "6px 9px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                borderLeft: `3px solid ${accent ? "var(--info, #2f81f7)" : "var(--ok, #2ea043)"}`,
                background: "var(--bg-subtle, rgba(127,127,127,0.04))",
              }}
            >
              {it}
            </li>
          ))}
        </ul>
      )}
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

const brief_panel: React.CSSProperties = { background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: 16, marginBottom: 18 };
const briefToggle: React.CSSProperties = { background: "transparent", border: "none", color: t.textMuted, cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 };
const stackChip: React.CSSProperties = { fontSize: 11, padding: "2px 8px", borderRadius: 999, border: `1px solid ${t.border}`, color: t.textMuted };
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

function card(active: boolean): React.CSSProperties {
  return { display: "flex", flexDirection: "column", width: "100%", textAlign: "left", background: active ? t.surface3 : t.surface2, border: `1px solid ${active ? t.borderActive : t.border2}`, borderRadius: 8, padding: "9px 10px", marginBottom: 8, color: t.text, cursor: "pointer" };
}
