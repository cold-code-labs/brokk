"use client";

import type { Plan, Project } from "@brokk/sdk";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlaskConical } from "lucide-react";
import { Main, Banner, Button } from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import {
  qa,
  type QaCatalog,
  type QaRun,
  type QaScenario,
  type QaVerdict,
} from "../lib/chat";
import { useProject } from "../lib/project-context";
import { useToast } from "./Toaster";

function tally(results: { verdict: QaVerdict }[]) {
  let pass = 0;
  let fail = 0;
  let blocked = 0;
  for (const r of results) {
    if (r.verdict === "pass") pass += 1;
    else if (r.verdict === "fail") fail += 1;
    else blocked += 1;
  }
  return { pass, fail, blocked };
}

/** Project QA home — catalog archive + run history (sibling of Huginn Discovery). */
export default function QaPage({ projectId }: { projectId?: string }) {
  const { setCurrentId } = useProject();
  const [project, setProject] = useState<Project | null>(null);
  const [catalog, setCatalog] = useState<QaCatalog | null>(null);
  const [runs, setRuns] = useState<QaRun[]>([]);
  const [stale, setStale] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const [storyBusy, setStoryBusy] = useState(false);
  const [stories, setStories] = useState<Plan[]>([]);
  const [prBusy, setPrBusy] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (projectId) setCurrentId(projectId);
  }, [projectId, setCurrentId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const projects = await brokk.listProjects();
        if (!alive) return;
        setProject((projectId ? projects.find((x) => x.id === projectId) : projects[0]) ?? null);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [cat, hist, plansRes] = await Promise.all([
        qa.get(projectId),
        qa.runs(projectId, 30),
        brokk.listPlans(projectId).catch(() => ({ plans: [] as Plan[] })),
      ]);
      setCatalog(cat.catalog);
      setStale(Boolean(cat.stale));
      setDiscovering(cat.running || cat.catalog?.status === "pending");
      setRuns(hist.runs);
      setStories((plansRes.plans ?? []).filter((p) => p.storyModule));
    } catch {
      /* keep prior */
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    setLoaded(false);
    void load();
  }, [load]);

  useEffect(() => {
    if (!discovering && !runs.some((r) => r.status === "running")) return;
    const i = setInterval(() => void load(), 4000);
    return () => clearInterval(i);
  }, [discovering, runs, load]);

  async function rediscover() {
    if (!projectId) return;
    try {
      await qa.discover(projectId);
      setDiscovering(true);
      setCatalog((c) => (c ? { ...c, status: "pending" } : c));
    } catch {
      /* ignore */
    }
  }

  /** Materialize Discovery scenarios + fail/blocked findings as proposed backlog cards. */
  async function createCards(runId?: string) {
    if (!projectId) return;
    setCardBusy(true);
    try {
      const { created, skipped } = await brokk.backlogFromQa(projectId, {
        source: "both",
        runId,
      });
      if (created.length) {
        toast(
          `${created.length} card${created.length === 1 ? "" : "s"} no backlog.`,
          {
            meta: skipped ? `${skipped} já existiam` : "Approve all enfileira só os qa-fail.",
            tone: "ok",
          },
        );
      } else {
        toast(skipped ? `Tudo já cardado (${skipped}).` : "Nada pra criar.", {
          tone: "info",
        });
      }
    } catch (e) {
      toast("Não deu pra criar cards.", { meta: String(e), tone: "err" });
    } finally {
      setCardBusy(false);
    }
  }

  /** ADR 0069: group qa-fail → Story Plans (1 PR per module). */
  async function approveStories() {
    if (!projectId) return;
    setStoryBusy(true);
    try {
      const { stories: created, enqueued, modules } = await brokk.approveQaStories(projectId, {
        includeQueued: true,
      });
      await load();
      if (modules) {
        toast(`${modules} Story · ${enqueued} cards no forge.`, {
          meta: created.map((s) => s.module).join(", "),
          tone: "ok",
        });
      } else {
        toast("Nenhum qa-fail solto pra agrupar.", { tone: "info" });
      }
    } catch (e) {
      toast("Não deu pra criar Stories.", { meta: String(e), tone: "err" });
    } finally {
      setStoryBusy(false);
    }
  }

  async function openStoryPr(planId: string, override = false) {
    setPrBusy(planId);
    try {
      const { plan, eitri } = await brokk.openPlanPr(planId, { override });
      await load();
      toast(plan.prUrl ? `PR aberto.` : "PR.", {
        meta: eitri ? `Eitri: ${eitri.ok ? "ok" : eitri.detail ?? "fail"}` : undefined,
        tone: eitri && !eitri.ok ? "err" : "ok",
      });
    } catch (e) {
      toast("Não abriu o PR.", { meta: String(e), tone: "err" });
    } finally {
      setPrBusy(null);
    }
  }

  const scenarios: QaScenario[] =
    catalog?.status === "ready" ? catalog.scenarios : [];
  const q = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      !q
        ? scenarios
        : scenarios.filter(
            (s) =>
              s.id.toLowerCase().includes(q) ||
              s.title.toLowerCase().includes(q) ||
              s.module.toLowerCase().includes(q) ||
              s.tags.some((t) => t.toLowerCase().includes(q)),
          ),
    [scenarios, q],
  );

  const status = discovering ? "pending" : catalog?.status;
  const lastReady = runs.find((r) => r.status === "ready" || r.status === "failed") ?? null;
  const chatHref = "/chat";

  return (
    <Main className="forge-room">
      <header className="forge-head">
        <Link href={projectId ? `/projects/${projectId}` : "/fleet"} className="forge-crumb">
          ← Forge
        </Link>
        <div className="forge-head-top">
          <div className="forge-head-copy">
            <span className="forge-eyebrow">Huginn · QA</span>
            <h1 className="forge-title">{project ? project.name : "QA"}</h1>
            <p className="forge-sub">
              Discovery → QA → Forge. Catálogo de cenários e histórico Full / Targeted. Execution no Sindri.
            </p>
            {status === "pending" && (
              <span className="forge-pulse" style={{ marginTop: "0.8rem" }}>
                <span className="forge-ember" />
                Scouting…
              </span>
            )}
            {stale && status === "ready" && (
              <span className="forge-pulse" style={{ marginTop: "0.8rem" }} title="Routes/features/e2e fingerprint drifted">
                <span className="forge-ember" />
                Catalog stale — rediscover
              </span>
            )}
          </div>
          <div className="forge-head-actions">
            <Button asChild variant="outline" size="sm">
              <Link href={chatHref}>Open in Sindri</Link>
            </Button>
            {catalog?.status === "ready" && (
              <Button
                size="sm"
                type="button"
                onClick={() => void createCards(lastReady?.id)}
                disabled={cardBusy || !projectId}
              >
                {cardBusy ? "Criando…" : "Criar cards no Quadro"}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void approveStories()}
              disabled={storyBusy || !projectId}
              title="Agrupa qa-fail por módulo → 1 Story (Plan) · 1 branch · 1 PR no fim"
            >
              {storyBusy ? "Stories…" : "Approve QA Stories"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void rediscover()}
              disabled={status === "pending" || !projectId}
            >
              {status === "pending" ? "Discovering…" : catalog ? "Discover again" : "Discover"}
            </Button>
          </div>
        </div>
        <div className="forge-head-rule" />
      </header>

      {!loaded && <p className="ygg-dim" style={{ fontSize: 13 }}>Loading…</p>}

      {stories.length > 0 && (
        <section style={{ marginBottom: "1.7rem" }}>
          <div className="forge-h" style={{ marginBottom: "0.6rem" }}>
            <span className="forge-h-title">Stories</span>
            <span className="forge-h-meta">{stories.length}</span>
            <span className="forge-h-rule" />
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
            {stories.map((s) => {
              const canOpen =
                !s.prUrl && (s.validationStatus === "pass" || s.validationStatus === "fail");
              return (
                <li
                  key={s.id}
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "0.5rem 1rem",
                    alignItems: "center",
                    fontSize: 13,
                  }}
                >
                  <strong>{s.summary}</strong>
                  <span className="ygg-dim">{s.featureBranch}</span>
                  <span className="ygg-dim">
                    re-QA {s.validationStatus ?? "—"}
                    {s.prUrl ? " · PR" : " · PR —"}
                  </span>
                  {s.prUrl ? (
                    <a href={s.prUrl} target="_blank" rel="noreferrer">
                      abrir PR
                    </a>
                  ) : canOpen ? (
                    <Button
                      size="sm"
                      type="button"
                      disabled={prBusy === s.id}
                      onClick={() =>
                        void openStoryPr(s.id, s.validationStatus !== "pass")
                      }
                    >
                      {prBusy === s.id
                        ? "Abrindo…"
                        : s.validationStatus === "pass"
                          ? "Abrir PR + Eitri"
                          : "Abrir PR (override)"}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {loaded && !catalog && status !== "pending" && (
        <div className="forge-empty is-panel">
          <span className="forge-empty-mark">
            <FlaskConical />
          </span>
          <span className="forge-empty-title">No QA catalog yet</span>
          <p className="forge-empty-sub">
            Discovery builds user-journey scenarios from routes, features, and e2e. Run it here or from Sindri chips.
          </p>
          <span className="forge-empty-action">
            <Button type="button" onClick={() => void rediscover()}>
              Discover
            </Button>
          </span>
        </div>
      )}

      {status === "failed" && catalog?.error && (
        <Banner tone="err">Discovery failed — {catalog.error}. Discover again to retry.</Banner>
      )}

      {catalog?.status === "ready" && (
        <section style={{ display: "grid", gap: "1.7rem" }}>
          <div>
            {catalog.summary && <p className="forge-lead">{catalog.summary}</p>}
            <p className="forge-lead-sub">
              {scenarios.length} scenarios
              {catalog.fingerprint ? ` · fingerprint ${catalog.fingerprint.slice(0, 12)}` : ""}
              {catalog.model ? ` · model ${catalog.model}` : ""}
              {stale ? " · stale" : ""}
            </p>
          </div>

          <div>
            <div className="forge-h" style={{ marginBottom: "0.6rem" }}>
              <span className="forge-h-title">Scenarios</span>
              <span className="forge-h-meta">{visible.length}</span>
              <span className="forge-h-rule" />
            </div>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by id, module, tag…"
              className="ygg-input"
              style={{ width: "100%", maxWidth: 360, marginBottom: "0.8rem", fontSize: 13 }}
            />
            {visible.length === 0 ? (
              <p className="forge-note" style={{ margin: 0 }}>
                —
              </p>
            ) : (
              <ul className="forge-tally is-built" style={{ listStyle: "none", padding: 0 }}>
                {visible.map((s) => (
                  <li key={s.id} style={{ marginBottom: 8 }}>
                    <code style={{ fontSize: 12 }}>{s.id}</code>
                    <span className="ygg-dim"> · {s.module} · {s.priority}</span>
                    {s.tags.length > 0 && (
                      <span className="ygg-dim"> · {s.tags.join(", ")}</span>
                    )}
                    <div style={{ fontSize: 13 }}>{s.title}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="forge-h" style={{ marginBottom: "0.6rem" }}>
              <span className="forge-h-title">Runs</span>
              <span className="forge-h-meta">{runs.length}</span>
              <span className="forge-h-rule" />
            </div>
            {runs.length === 0 ? (
              <p className="forge-note" style={{ margin: 0 }}>
                No Full / Targeted runs yet. Start from Sindri with Claude CLI + Assistir o agente.
              </p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }}>
                {runs.map((run) => {
                  const t = tally(run.results);
                  const open = expanded === run.id;
                  return (
                    <li key={run.id}>
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : run.id)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          color: "inherit",
                        }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                          {run.mode === "full" ? "Full QA" : "Targeted"} · {run.status}
                        </span>
                        <span className="ygg-dim" style={{ fontSize: 12, marginLeft: 8 }}>
                          {new Date(run.createdAt).toLocaleString()}
                        </span>
                        {run.status === "ready" || run.results.length > 0 ? (
                          <div style={{ fontSize: 13, marginTop: 2 }}>
                            {t.pass} passed · {t.fail} failed · {t.blocked} blocked
                          </div>
                        ) : run.status === "running" ? (
                          <div style={{ fontSize: 13, marginTop: 2 }} className="ygg-dim">
                            Running…
                          </div>
                        ) : null}
                      </button>
                      {open && (
                        <div style={{ marginTop: 8, paddingLeft: 4, fontSize: 13 }}>
                          {run.summary && <p className="forge-note">{run.summary}</p>}
                          {run.results.length > 0 ? (
                            <ul className="forge-tally is-built" style={{ listStyle: "none", padding: 0 }}>
                              {run.results.map((r) => (
                                <li key={r.id}>
                                  <code>{r.id}</code> · {r.verdict}
                                  {r.note ? ` — ${r.note}` : ""}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="forge-note">No scenario results yet.</p>
                          )}
                          {run.sessionId && (
                            <Link href={`/chat?session=${run.sessionId}`} className="forge-crumb">
                              Open session →
                            </Link>
                          )}
                          {(run.status === "ready" || run.results.length > 0) && (
                            <div style={{ marginTop: 8 }}>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={cardBusy}
                                onClick={() => void createCards(run.id)}
                              >
                                {cardBusy ? "Criando…" : "Cards desta run"}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {lastReady?.summary && runs[0]?.id === lastReady.id && !expanded && (
              <p className="forge-lead-sub" style={{ marginTop: "0.8rem" }}>
                Latest: {lastReady.summary.slice(0, 200)}
                {lastReady.summary.length > 200 ? "…" : ""}
              </p>
            )}
          </div>
        </section>
      )}
    </Main>
  );
}
