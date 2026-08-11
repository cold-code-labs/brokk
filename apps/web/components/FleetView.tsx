"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Flame, FolderGit2, MessageSquare, Pin } from "lucide-react";
import { Button, Banner } from "@cold-code-labs/yggdrasil-react";
import { STATUS_COLOR } from "../lib/theme";
import { discovery, type BriefStatus } from "../lib/chat";
import { useProject } from "../lib/project-context";
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

export type HouseBrief = {
  status: BriefStatus | null;
  missing: string[];
  running: boolean;
  mission: string | null;
};

export type DockSession = {
  sessionId: string;
  projectId: string;
  projectName: string;
  title: string;
  updatedAt: string;
  turnState: "idle" | "running";
};

function ProjectCard({
  project,
  repo,
  running,
  counts,
  brief,
  attention,
  pinned,
  onTogglePin,
  onQueueMissing,
  onOpenChat,
}: {
  project: Project;
  repo?: Repository;
  running: number;
  counts: (s: string) => number;
  brief?: HouseBrief;
  attention: number;
  pinned: boolean;
  onTogglePin: () => void;
  onQueueMissing: (text: string) => void;
  onOpenChat: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  function move(e: React.MouseEvent) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }
  const missing = brief?.missing?.slice(0, 3) ?? [];
  const hot = attention >= 40 || running > 0;

  return (
    <div
      ref={ref}
      onMouseMove={move}
      className={`fleet-card${running > 0 ? " is-running" : ""}${hot ? " is-hot" : ""}`}
    >
      <span className="fleet-card-rail" />
      <div className="fleet-card-head">
        <Link
          href={`/projects/${project.id}`}
          className="fleet-card-name"
          style={{ textDecoration: "none", color: "inherit" }}
        >
          {project.name}
        </Link>
        <div className="fleet-card-head-actions">
          <button
            type="button"
            className={`fleet-pin-btn${pinned ? " is-on" : ""}`}
            aria-label={pinned ? "Unpin from House" : "Pin to House"}
            title={pinned ? "Unpin" : "Pin"}
            onClick={onTogglePin}
          >
            {pinned ? <Pin size={14} strokeWidth={2.25} /> : <Pin size={14} strokeWidth={1.75} />}
          </button>
          {running > 0 ? (
            <span className="fleet-card-state running">
              <span className="fleet-run-dot" />
              {running} running
            </span>
          ) : (
            <span className="fleet-card-state idle">idle</span>
          )}
        </div>
      </div>
      <p className="fleet-card-repo">{repo ? `${repo.fullName} · ${project.baseBranch}` : "—"}</p>
      {brief?.mission ? <p className="fleet-card-mission">{brief.mission}</p> : null}
      <div className="fleet-card-badges">
        <EnvPrepBadge projectId={project.id} />
        <span className="ygg-badge">{counts("backlog")} backlog</span>
        <span className="ygg-badge" data-tone={counts("queued") ? "warn" : undefined}>
          {counts("queued")} queued
        </span>
        <span className="ygg-badge" data-tone={counts("review") ? "info" : undefined}>
          {counts("review")} PR
        </span>
        {missing.length > 0 ? (
          <span className="ygg-badge" data-tone="warn">
            {brief!.missing.length} missing
          </span>
        ) : null}
      </div>
      {missing.length > 0 ? (
        <ul className="fleet-missing">
          {missing.map((m) => (
            <li key={m}>
              <button type="button" className="fleet-missing-item" onClick={() => onQueueMissing(m)} title="Queue this gap">
                <span className="fleet-missing-mark">+</span>
                <span className="fleet-missing-text">{m}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : brief?.status === "ready" ? (
        <p className="fleet-missing-empty">Huginn: nothing flagged missing</p>
      ) : null}
      <div className="fleet-card-ctas">
        <button type="button" className="fleet-cta" onClick={onOpenChat}>
          <MessageSquare size={13} strokeWidth={2} aria-hidden />
          Chat
        </button>
        <Link href={`/projects/${project.id}`} className="fleet-cta">
          Board
        </Link>
      </div>
    </div>
  );
}

export interface FleetViewProps {
  projects: Project[];
  repoById: Map<string, Repository>;
  projectById: Map<string, Project>;
  tasksByProject: Map<string, Task[]>;
  briefsByProject: Record<string, HouseBrief>;
  attentionOf: (projectId: string) => number;
  pinnedIds: string[];
  onTogglePin: (projectId: string) => void;
  dockSessions: DockSession[];
  queue: Task[];
  counts: { running: number; queued: number; review: number; seats: number };
  err: string | null;
  pid: string;
  title: string;
  busy: boolean;
  onPid: (v: string) => void;
  onTitle: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onQueueMissing: (projectId: string, missing: string) => void;
}

/** Pure presentational House. All data arrives as props so it renders identically
 *  under live data or a static screenshot harness (the `Litr` visual-verify loop). */
export default function FleetView(p: FleetViewProps) {
  const running = p.counts.running;
  const router = useRouter();
  const { setCurrentId, getLastSession, pinnedProjects } = useProject();

  function openAnvilChat(projectId: string) {
    setCurrentId(projectId);
    const sid = getLastSession(projectId);
    router.push(sid ? `/chat?session=${encodeURIComponent(sid)}` : "/chat");
  }

  return (
    <main className="fleet forge-room">
      <header className="fleet-hero">
        <div className="fleet-aurora" aria-hidden />
        <div className="fleet-hero-inner">
          <div className="fleet-hero-copy">
            <span className="fleet-eyebrow">Brokk · CCL House</span>
            <h1 className="fleet-title">House</h1>
            <p className="fleet-subtitle">
              Macro view of every anvil. Pin clients, queue gaps, jump into chat — the forge
              burns in parallel.
            </p>
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

      {/* Pinned clients — keyboard 1–9 handled in Topbar */}
      <section className="fleet-pins" aria-label="Pinned projects">
        <div className="fleet-h">
          <span className="fleet-h-title">Pinned</span>
          <span className="fleet-h-meta">
            {pinnedProjects.length > 0
              ? `${pinnedProjects.length} · keys 1–${Math.min(pinnedProjects.length, 9)}`
              : "pin active clients"}
          </span>
          <span className="fleet-h-rule" />
        </div>
        {pinnedProjects.length === 0 ? (
          <div className="fleet-pins-empty">
            Pin up to 9 clients (Dekaprint, Viken, Arte One…) so you can switch anvils in one keystroke.
            Use the pin on any attention card below.
          </div>
        ) : (
          <div className="fleet-pin-strip">
            {pinnedProjects.map((proj, i) => {
              const ts = p.tasksByProject.get(proj.id) ?? [];
              const run = ts.filter((t) => t.status === "running").length;
              return (
                <button
                  key={proj.id}
                  type="button"
                  className={`fleet-pin-chip${run > 0 ? " is-running" : ""}${
                    p.pid === proj.id ? " is-active" : ""
                  }`}
                  onClick={() => openAnvilChat(proj.id)}
                  title={`${proj.name} · ${i + 1}`}
                >
                  <kbd className="fleet-pin-key">{i + 1}</kbd>
                  <span className="fleet-pin-name">{proj.name}</span>
                  {run > 0 ? <span className="fleet-run-dot" /> : null}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Primary gesture: Queue → */}
      <form onSubmit={p.onSubmit} className="fleet-composer is-hotspot">
        <div className="fleet-pick">
          <select value={p.pid} onChange={(e) => p.onPid(e.target.value)} aria-label="Project">
            {p.projects.length === 0 && <option value="">no project — connect a repo</option>}
            {p.projects.map((proj) => (
              <option key={proj.id} value={proj.id}>
                {proj.name}
              </option>
            ))}
          </select>
        </div>
        <input
          className="fleet-ask"
          value={p.title}
          onChange={(e) => p.onTitle(e.target.value)}
          placeholder="Prompt for the anvil — queues a forge card…"
        />
        <button type="submit" className="fleet-send" disabled={p.busy || !p.pid || !p.title.trim()}>
          {p.busy ? "Forging…" : "Queue →"}
        </button>
      </form>

      <div className="fleet-stats is-quiet">
        <Stat value={p.counts.running} label="Running now" live />
        <Stat value={p.counts.queued} label="Queued" />
        <Stat value={p.counts.review} label="In review · PR" live />
        <Stat value={p.counts.seats} label="Max seats" />
      </div>

      {/* Attention board */}
      <section className="forge-section">
        <div className="fleet-h">
          <span className="fleet-h-title">Attention</span>
          <span className="fleet-h-meta">
            {p.projects.length} · sorted by need
          </span>
          <span className="fleet-h-rule" />
        </div>
        {p.projects.length === 0 ? (
          <div className="fleet-empty is-panel">
            <span className="fleet-empty-mark">
              <FolderGit2 />
            </span>
            <span className="fleet-empty-title">No repos at the house yet</span>
            <p className="fleet-empty-sub">
              Connect a repository and Brokk can pick up tasks, open PRs, and forge previews for
              it.
            </p>
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
                  brief={p.briefsByProject[proj.id]}
                  attention={p.attentionOf(proj.id)}
                  pinned={p.pinnedIds.includes(proj.id)}
                  onTogglePin={() => p.onTogglePin(proj.id)}
                  onQueueMissing={(text) => p.onQueueMissing(proj.id, text)}
                  onOpenChat={() => openAnvilChat(proj.id)}
                />
              );
            })}
            <Link href="/connect" className="fleet-card is-add">
              + Connect a repo
            </Link>
          </div>
        )}
      </section>

      {/* Session dock */}
      <section className="fleet-dock" aria-label="Recent sessions">
        <div className="fleet-h">
          <span className="fleet-h-title">Session dock</span>
          <span className="fleet-h-meta">resume without hunting</span>
          <span className="fleet-h-rule" />
        </div>
        {p.dockSessions.length === 0 ? (
          <div className="fleet-dock-empty">
            Open a chat on a pinned project — it lands here for one-click resume.
          </div>
        ) : (
          <div className="fleet-dock-strip">
            {p.dockSessions.map((s) => (
              <button
                key={s.sessionId}
                type="button"
                className={`fleet-dock-chip${s.turnState === "running" ? " is-running" : ""}`}
                onClick={() => {
                  setCurrentId(s.projectId);
                  router.push(`/chat?session=${encodeURIComponent(s.sessionId)}`);
                }}
              >
                <span className="fleet-dock-proj">{s.projectName}</span>
                <span className="fleet-dock-title">{s.title}</span>
                {s.turnState === "running" ? <span className="fleet-run-dot" /> : null}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Global queue */}
      <section>
        <div className="fleet-h">
          <span className="fleet-h-title">Global queue</span>
          <span className="fleet-h-meta">next up across the house</span>
          <span className="fleet-h-rule" />
        </div>
        <div className="fleet-queue">
          {p.queue.length === 0 && (
            <div className="fleet-empty">
              <span className="fleet-empty-mark">
                <Flame />
              </span>
              <span className="fleet-empty-title">The forge is quiet</span>
              <p className="fleet-empty-sub">
                Queued and running tasks line up here, next-up first. Describe a task above to
                light it — or click a Huginn missing item.
              </p>
            </div>
          )}
          {p.queue.map((task) => {
            const proj = p.projectById.get(task.projectId);
            const repo = proj ? p.repoById.get(proj.repositoryId) : undefined;
            const isRunning = task.status === "running";
            return (
              <Link
                key={task.id}
                href={`/projects/${task.projectId}`}
                className={`fleet-row${isRunning ? " is-running" : ""}`}
              >
                <span className="fleet-row-dot" style={{ background: STATUS_COLOR[task.status] }} />
                <span className="fleet-row-title">{task.title}</span>
                <span className="fleet-row-repo">{repo?.name ?? proj?.name ?? ""}</span>
                <span className="fleet-row-status" style={{ color: STATUS_COLOR[task.status] }}>
                  {task.status}
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}
