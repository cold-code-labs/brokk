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
import { analysis as analysisApi, type TaskAnalysis } from "../lib/chat";
import { useProject } from "../lib/project-context";
import { STATUS_COLOR, STATUS_LABEL, t } from "../lib/theme";
import { AgentAvatar } from "./AgentAvatar";
import { PreviewChip } from "./PreviewChip";

const COLUMNS = ["backlog", "analysis", "queued", "running", "review", "done", "failed"] as const;

/** Status → Yggdrasil badge tone (the four supported tones). */
const STATUS_TONE: Record<string, "ok" | "warn" | "err" | "info" | undefined> = {
  analysis: "info",
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

  // Kick Resolve on a card — moves it into the Analysis column and opens the drawer
  // so you can watch the plan land.
  async function analyze(id: string) {
    try {
      await analysisApi.scout(id);
      setSelected(id);
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
                          <span onClick={(e) => { e.stopPropagation(); analyze(task.id); }} style={analyzeBtn}>
                            analyze →
                          </span>
                        )}
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

      {selectedTask && (
        <Detail
          task={selectedTask}
          onClose={() => setSelected(null)}
          onChanged={() => refresh(project?.id)}
        />
      )}
    </Main>
  );
}

function Detail({ task, onClose, onChanged }: { task: Task; onClose: () => void; onChanged: () => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const isAnalysis = task.status === "analysis";

  useEffect(() => {
    // A card in analysis has no runs yet — its drawer is the plan, not the log.
    if (isAnalysis) return;
    let unsub: (() => void) | undefined;
    setEvents([]);
    (async () => {
      const rs = await brokk.listTaskRuns(task.id).catch(() => [] as Run[]);
      setRuns(rs);
      const latest = rs[0];
      if (latest) unsub = brokk.streamRunEvents(latest.id, (e) => setEvents((prev) => [...prev, e]));
    })();
    return () => unsub?.();
  }, [task.id, isAnalysis]);

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

        {isAnalysis ? (
          <AnalysisPanel task={task} onChanged={onChanged} onClose={onClose} />
        ) : (
          <>
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
          </>
        )}
      </aside>
    </div>
  );
}

/** The Analysis drawer — Resolve's "visão pra resolução". Polls the card's analysis
 *  while the scout runs, then renders the plan: approach + rationale, the ordered
 *  steps (with the files each touches), and the open questions. Questions get an
 *  answer box that re-runs Resolve; "Aprovar" enqueues (atomic) or spawns the
 *  sub-cards (feature). */
function AnalysisPanel({ task, onChanged, onClose }: { task: Task; onChanged: () => void; onClose: () => void }) {
  const [analysis, setAnalysis] = useState<TaskAnalysis | null>(null);
  const [running, setRunning] = useState(false);
  const [answers, setAnswers] = useState("");
  const [detailsInput, setDetailsInput] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "reanalyze" | "details">(null);
  const [err, setErr] = useState<string | null>(null);
  // Non-technical-first: the plain summary + premises lead; the technical detail
  // (rationale + per-step internals) starts collapsed behind a toggle, and each
  // step expands on demand. History is opt-in too.
  const [showTech, setShowTech] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [openSteps, setOpenSteps] = useState<Record<number, boolean>>({});

  // Poll the analysis while a scout is in flight (or the row is still pending).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await analysisApi.get(task.id);
        if (!alive) return;
        setAnalysis(r.analysis);
        setRunning(r.running || r.analysis?.status === "pending");
      } catch {
        /* transient — keep polling */
      }
    };
    tick();
    const i = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [task.id]);

  async function approve() {
    setBusy("approve");
    setErr(null);
    try {
      await brokk.approveAnalysis(task.id);
      onChanged();
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function reanalyze() {
    setBusy("reanalyze");
    setErr(null);
    try {
      await analysisApi.answer(task.id, answers.trim());
      setAnswers("");
      setRunning(true);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  // "Adicionar Detalhes": new authoritative info → a full v+1 (title/citations/
  // details/plan), with the prior version snapshotted into history.
  async function addDetails() {
    if (!detailsInput.trim()) return;
    setBusy("details");
    setErr(null);
    try {
      await analysisApi.addDetails(task.id, detailsInput.trim());
      setDetailsInput("");
      setRunning(true);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  const pending = running || analysis?.status === "pending" || !analysis;
  const failed = analysis?.status === "failed";

  return (
    <div style={{ marginTop: 16 }}>
      <h3 className="ygg-muted" style={{ fontSize: 12, textTransform: "uppercase", margin: "0 0 10px", letterSpacing: 0.4 }}>
        Resolve · visão da resolução
      </h3>

      {err && <Banner tone="err">⚠ {err}</Banner>}

      {pending && !failed && (
        <p className="ygg-dim" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ ...dot, background: STATUS_COLOR.analysis, marginTop: 0 }} />
          Resolve está lendo o checkout e montando o plano…
        </p>
      )}

      {failed && (
        <>
          <pre style={{ ...logBox, color: STATUS_COLOR.failed, maxHeight: 140 }}>{analysis?.error ?? "falhou"}</pre>
          <Button size="sm" variant="outline" onClick={reanalyze} disabled={busy !== null} style={{ marginTop: 10 }}>
            {busy === "reanalyze" ? "re-analisando…" : "Tentar de novo"}
          </Button>
        </>
      )}

      {analysis?.status === "ready" && (() => {
        const needsConfirm = analysis.questions.length > 0;
        const isFeature = analysis.mode === "feature";
        const titleChanged = !!analysis.revisedTitle && analysis.revisedTitle !== task.title;
        const problem = analysis.details || analysis.approach;
        return (
        <>
          {/* Sinais em destaque: versão + escopo + confiança (das premissas em aberto). */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <span className="ygg-badge">v{analysis.version}</span>
            <span className="ygg-badge" data-tone={isFeature ? "warn" : "ok"}>
              {isFeature ? `feature · ${analysis.steps.length} sub-cards` : "atomic · 1 PR"}
            </span>
            <span className="ygg-badge" data-tone={needsConfirm ? "warn" : "ok"}>
              {needsConfirm ? `⚠ ${analysis.questions.length} premissa(s) a confirmar` : "✓ plano confiante"}
            </span>
          </div>

          {/* Título corrigido — destaque: conserta a moldura enganosa que veio do card. */}
          {titleChanged && (
            <div style={{ ...calloutBox, borderColor: `${STATUS_COLOR.analysis}66`, borderLeftColor: STATUS_COLOR.analysis }}>
              <div className="ygg-dim" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
                Título corrigido
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>{analysis.revisedTitle}</div>
              <div className="ygg-dim" style={{ fontSize: 11, marginTop: 4, textDecoration: "line-through" }}>{task.title}</div>
              <div className="ygg-dim" style={{ fontSize: 11, marginTop: 3 }}>substitui o título do card ao aprovar</div>
            </div>
          )}

          {/* O problema em linguagem simples — a "manchete", pra qualquer pessoa entender. */}
          {problem && (
            <p style={{ fontSize: 15, lineHeight: 1.5, margin: "0 0 6px", fontWeight: 500 }}>{problem}</p>
          )}
          <p className="ygg-dim" style={{ fontSize: 12.5, margin: "0 0 14px" }}>
            {isFeature
              ? `Trabalho maior — vira ${analysis.steps.length} sub-cards em sequência.`
              : "Mudança localizada — vira um PR direto."}
          </p>

          {/* Citações da reunião — verbatim, rastreabilidade real. */}
          {analysis.evidence.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div className="ygg-dim" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
                Da reunião
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {analysis.evidence.map((ev, i) => (
                  <blockquote key={i} style={quoteBox}>
                    <span style={{ fontSize: 13, lineHeight: 1.45, fontStyle: "italic" }}>“{ev.quote}”</span>
                    {(ev.speaker || ev.note) && (
                      <div className="ygg-dim" style={{ fontSize: 11, marginTop: 3 }}>
                        {ev.speaker ? `— ${ev.speaker}` : ""}
                        {ev.speaker && ev.note ? " · " : ""}
                        {ev.note ?? ""}
                      </div>
                    )}
                  </blockquote>
                ))}
              </div>
            </div>
          )}

          {/* Premissas a confirmar — elevado acima do técnico: é o que mais importa
              pro humano decidir (o seam de "não consigo julgar isso pelo código"). */}
          {needsConfirm && (
            <div style={calloutBox}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Antes de aprovar, confirme:</div>
              <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
                {analysis.questions.map((q, i) => (
                  <li key={i} style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 4 }}>{q}</li>
                ))}
              </ul>
              <textarea
                value={answers}
                onChange={(e) => setAnswers(e.target.value)}
                placeholder="Responda e re-analise para refinar o plano…"
                rows={3}
                style={{ ...field, width: "100%", resize: "vertical", minWidth: 0 }}
              />
              <Button size="sm" onClick={reanalyze} disabled={busy !== null || !answers.trim()} style={{ marginTop: 8 }}>
                {busy === "reanalyze" ? "re-analisando…" : "Re-analisar com respostas"}
              </Button>
            </div>
          )}

          {/* Detalhes técnicos — colapsados por padrão (não-técnico primeiro). */}
          <button type="button" onClick={() => setShowTech((v) => !v)} style={techToggle}>
            <span>{showTech ? "▾" : "▸"} Detalhes técnicos</span>
            <span className="ygg-dim" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
              {analysis.steps.length} passo(s)
            </span>
          </button>

          {showTech && (
            <div style={{ marginTop: 10 }}>
              {analysis.rationale && (
                <p className="ygg-muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: "0 0 12px" }}>
                  {analysis.rationale}
                </p>
              )}
              <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                {analysis.steps.map((s, i) => {
                  const open = !!openSteps[i];
                  return (
                    <li key={i} style={stepCard}>
                      <button
                        type="button"
                        onClick={() => setOpenSteps((m) => ({ ...m, [i]: !m[i] }))}
                        style={stepHead}
                      >
                        <span style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
                          <span className="ygg-dim" style={{ fontVariantNumeric: "tabular-nums" }}>{i + 1}.</span>
                          <span style={{ fontWeight: 600, fontSize: 13, minWidth: 0, wordBreak: "break-word" }}>{s.title}</span>
                        </span>
                        <span className="ygg-dim" style={{ fontSize: 11, flexShrink: 0, marginLeft: 8 }}>
                          {s.touches.length > 0 ? `${s.touches.length} arq. ` : ""}{open ? "▾" : "▸"}
                        </span>
                      </button>
                      {open && (
                        <div style={{ padding: "0 11px 11px" }}>
                          {s.detail && (
                            <div className="ygg-muted" style={{ fontSize: 12.5, lineHeight: 1.45, marginBottom: 6 }}>{s.detail}</div>
                          )}
                          {s.touches.length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
                              {s.touches.map((f) => (
                                <code key={f} style={touchChip}>{f}</code>
                              ))}
                            </div>
                          )}
                          {s.acceptance && <div className="ygg-dim" style={{ fontSize: 11.5 }}>✓ {s.acceptance}</div>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {/* Adicionar Detalhes — sempre disponível: injeta info nova e autoritativa
              (o que a IA não pôde saber), regenerando título/citações/plano numa v+1. */}
          <div style={{ marginTop: 16, borderTop: `1px solid ${t.border}`, paddingTop: 12 }}>
            <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, color: t.textMuted, fontWeight: 600, marginBottom: 8 }}>
              Adicionar detalhes
            </div>
            <textarea
              value={detailsInput}
              onChange={(e) => setDetailsInput(e.target.value)}
              placeholder="Sabe algo que a IA não sabe? Escreva — ela regenera título, citações e plano."
              rows={3}
              style={{ ...field, width: "100%", resize: "vertical", minWidth: 0 }}
            />
            <Button size="sm" variant="outline" onClick={addDetails} disabled={busy !== null || !detailsInput.trim()} style={{ marginTop: 8 }}>
              {busy === "details" ? "gerando revisão…" : `Gerar revisão → v${analysis.version + 1}`}
            </Button>
          </div>

          {/* Histórico de versões — a linhagem v1 → v2 → … */}
          {analysis.revisions.length > 0 && (
            <>
              <button type="button" onClick={() => setShowHistory((v) => !v)} style={techToggle}>
                <span>{showHistory ? "▾" : "▸"} Histórico</span>
                <span className="ygg-dim" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                  {analysis.revisions.length} versão(ões) anterior(es)
                </span>
              </button>
              {showHistory && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                  {[...analysis.revisions].reverse().map((r, i) => (
                    <div key={i} style={stepCard}>
                      <div style={{ padding: "9px 11px" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                          <span className="ygg-badge">v{r.version}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, wordBreak: "break-word" }}>
                            {r.title ?? task.title}
                          </span>
                        </div>
                        {r.inputDetails && (
                          <div className="ygg-dim" style={{ fontSize: 11.5, marginTop: 5 }}>
                            + detalhe: {r.inputDetails}
                          </div>
                        )}
                        {r.details && (
                          <div className="ygg-muted" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>{r.details}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Ações. Com premissas em aberto, Aprovar vira secundário — o CTA primário
              é responder+re-analisar (no callout acima). */}
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <Button onClick={approve} disabled={busy !== null} variant={needsConfirm ? "outline" : undefined}>
              {busy === "approve"
                ? "aprovando…"
                : needsConfirm
                  ? (isFeature ? "Aprovar mesmo assim → sub-cards" : "Aprovar mesmo assim → enfileirar")
                  : (isFeature ? "Aprovar → criar sub-cards" : "Aprovar → enfileirar")}
            </Button>
            {!needsConfirm && (
              <Button variant="outline" onClick={reanalyze} disabled={busy !== null}>
                {busy === "reanalyze" ? "…" : "Re-analisar"}
              </Button>
            )}
          </div>
        </>
        );
      })()}
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
const analyzeBtn: React.CSSProperties = { fontSize: 11, color: STATUS_COLOR.analysis, border: `1px solid ${STATUS_COLOR.analysis}44`, borderRadius: 6, padding: "2px 8px" };
const touchChip: React.CSSProperties = { fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, monospace", background: t.inset, border: `1px solid ${t.border}`, borderRadius: 5, padding: "1px 6px", color: t.textMuted };
const calloutBox: React.CSSProperties = { background: t.surface2, border: `1px solid ${STATUS_COLOR.queued}66`, borderLeft: `3px solid ${STATUS_COLOR.queued}`, borderRadius: 8, padding: "12px 14px", marginBottom: 16 };
const techToggle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", textAlign: "left", background: "transparent", border: "none", borderTop: `1px solid ${t.border}`, padding: "10px 0 2px", color: t.textMuted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, cursor: "pointer" };
const stepCard: React.CSSProperties = { border: `1px solid ${t.border}`, borderRadius: 8, background: t.surface2, overflow: "hidden" };
const stepHead: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "9px 11px", color: t.text, cursor: "pointer" };
const quoteBox: React.CSSProperties = { margin: 0, background: t.surface2, borderLeft: `3px solid ${t.border2}`, borderRadius: 6, padding: "8px 11px", color: t.text };
const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "flex-end", zIndex: 50 };
const drawer: React.CSSProperties = { width: "min(560px, 100%)", height: "100%", background: t.bg, borderLeft: `1px solid ${t.border}`, padding: 22, overflowY: "auto", boxShadow: "-20px 0 60px rgba(0,0,0,0.4)" };
const logBox: React.CSSProperties = { background: t.inset, border: `1px solid ${t.border}`, borderRadius: 8, padding: 10, fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11.5, lineHeight: 1.45, maxHeight: 360, overflowY: "auto", whiteSpace: "pre-wrap" };

function card(active: boolean): React.CSSProperties {
  return { display: "flex", flexDirection: "column", width: "100%", textAlign: "left", background: active ? t.surface3 : t.surface2, border: `1px solid ${active ? t.borderActive : t.border2}`, borderRadius: 8, padding: "11px 12px", marginBottom: 9, color: t.text, cursor: "pointer" };
}
