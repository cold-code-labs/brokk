"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Flame, FolderGit2 } from "lucide-react";
import { Button, Banner } from "@cold-code-labs/yggdrasil-react";
import { STATUS_COLOR } from "../lib/theme";
import { discovery, type BriefStatus } from "../lib/chat";
import type { Project, Repository, Task } from "@brokk/sdk";

/** A per-project "environment is being prepared" chip. Right after a repo is
 *  connected, Huginn clones it and detects its runtime (the discovery brief:
 *  pending → ready/failed). This surfaces that prep on the card so a just-
 *  connected project reads as "carregando", not "idle and empty". Self-contained:
 *  fetches its own brief and polls only while still preparing (so it costs
 *  nothing once the fleet is warm). Renders nothing when ready. */
function EnvPrepBadge({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<BriefStatus | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const tick = async () => {
      try {
        const res = await discovery.get(projectId);
        if (!alive) return;
        setRunning(res.running);
        setStatus(res.brief?.status ?? null);
        tries += 1;
        // Keep polling while a scout is in flight or the brief is still pending;
        // give a brand-new project a few tries to move none → pending before we
        // stop (legacy projects with no brief settle to "no badge" quickly).
        const keep =
          res.running || res.brief?.status === "pending" || (!res.brief && tries < 4);
        if (keep) timer = setTimeout(tick, 5000);
      } catch {
        /* ignore — the badge just won't show */
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  if (running || status === "pending")
    return (
      <span className="ygg-badge" data-tone="info">
        <span className="fleet-run-dot" /> preparando ambiente…
      </span>
    );
  if (status === "failed")
    return (
      <span className="ygg-badge" data-tone="err">
        ambiente falhou
      </span>
    );
  return null;
}

/** Count a number up on change (a tiny native number-ticker, no deps). Respects
 *  prefers-reduced-motion — jumps straight to the value. */
function useCountUp(value: number, ms = 700): number {
  const [n, setN] = useState(value);
  const from = useRef(value);
  const raf = useRef<number | undefined>(undefined);
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || from.current === value) {
      from.current = value;
      setN(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(Math.round(a + (value - a) * eased));
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value, ms]);
  return n;
}

function Stat({ value, label, live }: { value: number; label: string; live?: boolean }) {
  const n = useCountUp(value);
  return (
    <div className={`fleet-stat${live && value > 0 ? " is-live" : ""}`}>
      <div className="fleet-stat-num">{n}</div>
      <div className="fleet-stat-label">
        {live && value > 0 && <span className="fleet-stat-dot" />}
        {label}
      </div>
      <span className="fleet-stat-spark" />
    </div>
  );
}

/** Project card with a cursor-following spotlight (sets --mx/--my). */
function ProjectCard({
  project,
  repo,
  running,
  counts,
}: {
  project: Project;
  repo?: Repository;
  running: number;
  counts: (s: string) => number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  function move(e: React.MouseEvent) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }
  return (
    <div ref={ref} onMouseMove={move} className={`fleet-card${running > 0 ? " is-running" : ""}`}>
      <span className="fleet-card-rail" />
      <Link href={`/projects/${project.id}`} style={{ display: "block", textDecoration: "none", color: "inherit" }}>
        <div className="fleet-card-head">
          <span className="fleet-card-name">{project.name}</span>
          {running > 0 ? (
            <span className="fleet-card-state running">
              <span className="fleet-run-dot" />
              {running} running
            </span>
          ) : (
            <span className="fleet-card-state idle">idle</span>
          )}
        </div>
        <p className="fleet-card-repo">{repo ? `${repo.fullName} · ${project.baseBranch}` : "—"}</p>
      </Link>
      <div className="fleet-card-badges">
        <EnvPrepBadge projectId={project.id} />
        <span className="ygg-badge">{counts("backlog")} backlog</span>
        <span className="ygg-badge" data-tone={counts("queued") ? "warn" : undefined}>{counts("queued")} queued</span>
        <span className="ygg-badge" data-tone={counts("review") ? "info" : undefined}>{counts("review")} PR</span>
      </div>
    </div>
  );
}

export interface FleetViewProps {
  projects: Project[];
  repoById: Map<string, Repository>;
  projectById: Map<string, Project>;
  tasksByProject: Map<string, Task[]>;
  queue: Task[];
  counts: { running: number; queued: number; review: number; seats: number };
  err: string | null;
  pid: string;
  title: string;
  busy: boolean;
  onPid: (v: string) => void;
  onTitle: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

/** Pure presentational Fleet. All data arrives as props so it renders identically
 *  under live data or a static screenshot harness (the `Litr` visual-verify loop). */
export default function FleetView(p: FleetViewProps) {
  const running = p.counts.running;
  return (
    <main className="fleet forge-room">
      {/* nameplate — quiet; the hot spot is the queue bar below */}
      <header className="fleet-hero">
        <div className="fleet-aurora" aria-hidden />
        <div className="fleet-hero-inner">
          <div className="fleet-hero-copy">
            <span className="fleet-eyebrow">Brokk · the forge</span>
            <h1 className="fleet-title">Projects</h1>
            <p className="fleet-subtitle">Queue work onto any anvil. The forge runs the rest.</p>
          </div>
          <div className="fleet-hero-actions">
            <span className={`fleet-pulse${running > 0 ? "" : " is-quiet"}`}>
              <span className="fleet-ember" />
              {running > 0
                ? `Forging now · ${running} task${running > 1 ? "s" : ""} in the fire`
                : "The forge is quiet"}
            </span>
            <Button asChild>
              <Link href="/connect">+ Connect repos</Link>
            </Button>
          </div>
        </div>
      </header>

      {p.err && <Banner tone="err">⚠ {p.err}</Banner>}

      {/* fleet floor — primary gesture: Queue → */}
      <form onSubmit={p.onSubmit} className="fleet-composer is-hotspot">
        <div className="fleet-pick">
          <select value={p.pid} onChange={(e) => p.onPid(e.target.value)} aria-label="Project">
            {p.projects.length === 0 && <option value="">no project — connect a repo</option>}
            {p.projects.map((proj) => (
              <option key={proj.id} value={proj.id}>{proj.name}</option>
            ))}
          </select>
        </div>
        <input
          className="fleet-ask"
          value={p.title}
          onChange={(e) => p.onTitle(e.target.value)}
          placeholder="Describe a task and queue it to the forge…"
        />
        <button type="submit" className="fleet-send" disabled={p.busy || !p.pid || !p.title.trim()}>
          {p.busy ? "Forging…" : "Queue →"}
        </button>
      </form>

      {/* vitals — demoted under the gesture */}
      <div className="fleet-stats is-quiet">
        <Stat value={p.counts.running} label="Running now" live />
        <Stat value={p.counts.queued} label="Queued" />
        <Stat value={p.counts.review} label="In review · PR" live />
        <Stat value={p.counts.seats} label="Max seats" />
      </div>

      {/* projects */}
      <section className="forge-section">
        <div className="fleet-h">
          <span className="fleet-h-title">Projects</span>
          <span className="fleet-h-meta">{p.projects.length}</span>
          <span className="fleet-h-rule" />
        </div>
        {p.projects.length === 0 ? (
          <div className="fleet-empty is-panel">
            <span className="fleet-empty-mark"><FolderGit2 /></span>
            <span className="fleet-empty-title">No repos at the forge yet</span>
            <p className="fleet-empty-sub">Connect a repository and Brokk can pick up tasks, open PRs, and forge previews for it.</p>
            <span className="fleet-empty-action">
              <Button asChild>
                <Link href="/connect">+ Connect a repo</Link>
              </Button>
            </span>
          </div>
        ) : (
          <div className="fleet-cards">
            {p.projects.map((proj) => {
              const ts = p.tasksByProject.get(proj.id) ?? [];
              const c = (s: string) => ts.filter((x) => x.status === s).length;
              return (
                <ProjectCard
                  key={proj.id}
                  project={proj}
                  repo={p.repoById.get(proj.repositoryId)}
                  running={c("running")}
                  counts={c}
                />
              );
            })}
            <Link href="/connect" className="fleet-card is-add">+ Connect a repo</Link>
          </div>
        )}
      </section>

      {/* queue */}
      <section>
        <div className="fleet-h">
          <span className="fleet-h-title">Global queue</span>
          <span className="fleet-h-meta">next up across the fleet</span>
          <span className="fleet-h-rule" />
        </div>
        <div className="fleet-queue">
          {p.queue.length === 0 && (
            <div className="fleet-empty">
              <span className="fleet-empty-mark"><Flame /></span>
              <span className="fleet-empty-title">The forge is quiet</span>
              <p className="fleet-empty-sub">Queued and running tasks line up here, next-up first. Describe a task above to light it.</p>
            </div>
          )}
          {p.queue.map((task) => {
            const proj = p.projectById.get(task.projectId);
            const repo = proj ? p.repoById.get(proj.repositoryId) : undefined;
            const isRunning = task.status === "running";
            return (
              <Link key={task.id} href={`/projects/${task.projectId}`} className={`fleet-row${isRunning ? " is-running" : ""}`}>
                <span className="fleet-row-dot" style={{ background: STATUS_COLOR[task.status] }} />
                <span className="fleet-row-title">{task.title}</span>
                <span className="fleet-row-repo">{repo?.name ?? proj?.name ?? ""}</span>
                <span className="fleet-row-status" style={{ color: STATUS_COLOR[task.status] }}>{task.status}</span>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}
