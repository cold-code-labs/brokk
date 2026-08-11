"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Columns3, Eye, Flame, FolderGit2, MessageSquare, Pin, Target } from "lucide-react";
import { Button, Banner } from "@cold-code-labs/yggdrasil-react";
import type { HouseLifecycle, HouseObjective } from "@brokk/core";
import { STATUS_COLOR } from "../lib/theme";
import { discovery, type BriefStatus } from "../lib/chat";
import { useProject } from "../lib/project-context";
import type { Project, Repository, Task } from "@brokk/sdk";
import ObjectivePanel from "./ObjectivePanel";

export function projectLifecycle(p: Project): HouseLifecycle {
  return (p as Project & { houseLifecycle?: HouseLifecycle }).houseLifecycle ?? "undocumented";
}

export function projectObjective(p: Project): HouseObjective | null {
  return (p as Project & { houseObjective?: HouseObjective | null }).houseObjective ?? null;
}

export function needsObjective(p: Project): boolean {
  const life = projectLifecycle(p);
  if (life === "archived") return false;
  if (life === "undocumented") return true;
  return !projectObjective(p)?.summary;
}

const LIFE_LABEL: Record<HouseLifecycle, string> = {
  prototype: "Protótipo",
  undocumented: "Sem objetivo",
  working: "Trabalhando",
  archived: "Arquivado",
};

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
        /* ignore */
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
        <span className="fleet-run-dot" /> prep…
      </span>
    );
  if (status === "failed")
    return (
      <span className="ygg-badge" data-tone="err">
        env fail
      </span>
    );
  return null;
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

function IconBtn({
  label,
  onClick,
  href,
  busy,
  children,
}: {
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  href?: string;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const cls = `house-ico${busy ? " is-busy" : ""}`;
  if (href) {
    return (
      <Link
        href={href}
        className={cls}
        title={label}
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
    >
      {children}
    </button>
  );
}

function ProjectRow({
  project,
  repo,
  running,
  counts,
  brief,
  attention,
  pinned,
  pinIndex,
  previewBusy,
  onTogglePin,
  onQueueMissing,
  onOpenChat,
  onOpenPreview,
  onOpenObjective,
}: {
  project: Project;
  repo?: Repository;
  running: number;
  counts: (s: string) => number;
  brief?: HouseBrief;
  attention: number;
  pinned: boolean;
  pinIndex: number | null;
  previewBusy: boolean;
  onTogglePin: () => void;
  onQueueMissing: (text: string) => void;
  onOpenChat: () => void;
  onOpenPreview: () => void;
  onOpenObjective: () => void;
}) {
  const missing = brief?.missing ?? [];
  const topMissing = missing[0];
  const hot = attention >= 40 || running > 0;
  const queued = counts("queued");
  const review = counts("review");
  const backlog = counts("backlog");
  const life = projectLifecycle(project);
  const needObj = needsObjective(project);
  const archived = life === "archived";

  return (
    <div
      className={`house-row${running > 0 ? " is-running" : ""}${hot ? " is-hot" : ""}${
        needObj ? " needs-objective" : ""
      }${archived ? " is-archived" : ""}`}
      role="row"
    >
      <div className="house-cell house-cell-pin">
        <button
          type="button"
          className={`fleet-pin-btn${pinned ? " is-on" : ""}`}
          aria-label={pinned ? "Unpin" : "Pin"}
          title={pinned ? (pinIndex != null ? `Pinned · key ${pinIndex}` : "Unpin") : "Pin"}
          onClick={onTogglePin}
        >
          <Pin size={14} strokeWidth={pinned ? 2.25 : 1.75} />
          {pinIndex != null ? <span className="house-pin-idx">{pinIndex}</span> : null}
        </button>
      </div>

      <div className="house-cell house-cell-name">
        <Link href={`/projects/${project.id}`} className="house-name">
          {project.name}
        </Link>
        <span className="house-repo" title={repo?.fullName}>
          {repo ? `${repo.fullName} · ${project.baseBranch}` : "—"}
        </span>
      </div>

      <div className="house-cell house-cell-life">
        <button
          type="button"
          className={`house-life house-life-${life}${needObj ? " is-need" : ""}`}
          onClick={onOpenObjective}
          title="Objetivo / lifecycle"
        >
          {LIFE_LABEL[life]}
        </button>
        {needObj ? (
          <button type="button" className="house-need-prompt" onClick={onOpenObjective}>
            precisa objetivo
          </button>
        ) : null}
      </div>

      <div className="house-cell house-cell-state">
        {running > 0 ? (
          <span className="fleet-card-state running">
            <span className="fleet-run-dot" />
            {running} run
          </span>
        ) : (
          <span className="fleet-card-state idle">idle</span>
        )}
        <EnvPrepBadge projectId={project.id} />
      </div>

      <div className="house-cell house-cell-counts" aria-label="counts">
        <span className="house-count" title="backlog">
          {backlog}
          <em>bk</em>
        </span>
        <span className={`house-count${queued ? " is-warn" : ""}`} title="queued">
          {queued}
          <em>q</em>
        </span>
        <span className={`house-count${review ? " is-info" : ""}`} title="in review">
          {review}
          <em>pr</em>
        </span>
        {missing.length > 0 ? (
          <span className="house-count is-warn" title="Huginn missing">
            {missing.length}
            <em>gap</em>
          </span>
        ) : null}
      </div>

      <div className="house-cell house-cell-gap">
        {needObj ? (
          <button type="button" className="house-gap is-objective" onClick={onOpenObjective}>
            <span className="house-gap-mark">?</span>
            <span className="house-gap-text">Definir objetivo (entrevista)</span>
          </button>
        ) : topMissing ? (
          <button
            type="button"
            className="house-gap"
            title="Queue this gap to the forge"
            onClick={() => onQueueMissing(topMissing)}
          >
            <span className="house-gap-mark">+</span>
            <span className="house-gap-text">{topMissing}</span>
            {missing.length > 1 ? (
              <span className="house-gap-more">+{missing.length - 1}</span>
            ) : null}
          </button>
        ) : brief?.status === "ready" ? (
          <span className="house-gap-empty">—</span>
        ) : (
          <span className="house-gap-empty">{brief?.mission ? brief.mission : "…"}</span>
        )}
      </div>

      <div className="house-cell house-cell-cta">
        <IconBtn label="Objetivo" onClick={onOpenObjective}>
          <Target size={15} strokeWidth={1.75} />
        </IconBtn>
        <IconBtn label="Chat" onClick={onOpenChat}>
          <MessageSquare size={15} strokeWidth={1.75} />
        </IconBtn>
        <IconBtn label="Board" href={`/projects/${project.id}`}>
          <Columns3 size={15} strokeWidth={1.75} />
        </IconBtn>
        <IconBtn label="Preview" onClick={onOpenPreview} busy={previewBusy}>
          <Eye size={15} strokeWidth={1.75} />
        </IconBtn>
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
  previewBusyId: string | null;
  houseBusyId: string | null;
  onQueueMissing: (projectId: string, missing: string) => void;
  onOpenPreview: (projectId: string) => void;
  onSaveHouse: (
    projectId: string,
    next: {
      houseLifecycle: HouseLifecycle;
      houseObjective: HouseObjective;
      chatBrief: string;
    },
  ) => void | Promise<void>;
  onArchiveProject: (projectId: string) => void | Promise<void>;
}

/** House — full-bleed project list. Header + list + footer dock. */
export default function FleetView(p: FleetViewProps) {
  const running = p.counts.running;
  const router = useRouter();
  const { setCurrentId, getLastSession, pinnedProjects } = useProject();
  const listRef = useRef<HTMLDivElement>(null);
  const [objectiveId, setObjectiveId] = useState<string | null>(null);

  function openAnvilChat(projectId: string) {
    setCurrentId(projectId);
    const sid = getLastSession(projectId);
    router.push(sid ? `/chat?session=${encodeURIComponent(sid)}` : "/chat");
  }

  const pinRank = new Map(p.pinnedIds.map((id, i) => [id, i + 1]));
  const needCount = p.projects.filter(needsObjective).length;
  const objectiveProject = objectiveId
    ? p.projects.find((x) => x.id === objectiveId) ?? null
    : null;

  return (
    <main className={`fleet forge-room is-house${objectiveProject ? " has-obj" : ""}`}>
      <header className="house-bar">
        <div className="house-bar-brand">
          <span className="fleet-eyebrow">Brokk · CCL</span>
          <h1 className="house-bar-title">House</h1>
          <span className={`fleet-pulse${running > 0 ? "" : " is-quiet"}`}>
            <span className="fleet-ember" />
            {running > 0
              ? `${running} forging · ${p.counts.queued} queued · ${p.counts.review} PR`
              : `quiet · ${p.projects.length} projects · ${p.counts.seats} seats`}
          </span>
          {needCount > 0 ? (
            <span className="house-need-count">{needCount} sem objetivo</span>
          ) : null}
        </div>
        <div className="house-bar-actions">
          {pinnedProjects.length > 0 ? (
            <div className="fleet-pin-strip house-bar-pins" aria-label="Pinned">
              {pinnedProjects.map((proj, i) => {
                const ts = p.tasksByProject.get(proj.id) ?? [];
                const run = ts.filter((t) => t.status === "running").length;
                return (
                  <button
                    key={proj.id}
                    type="button"
                    className={`fleet-pin-chip${run > 0 ? " is-running" : ""}${
                      needsObjective(proj) ? " needs-objective" : ""
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
          ) : (
            <span className="house-bar-hint">Pin clients · keys 1–9 · objetivo = única etapa humana</span>
          )}
          <Button asChild>
            <Link href="/connect">+ Connect</Link>
          </Button>
        </div>
      </header>

      {p.err && <Banner tone="err">⚠ {p.err}</Banner>}

      <div className="house-body">
      <section className="house-list-wrap" aria-label="All projects">
        <div className="house-list-head" role="row">
          <span className="house-cell house-cell-pin" />
          <span className="house-cell house-cell-name">
            Project
            <em className="house-list-meta">
              {p.projects.length} · by need
            </em>
          </span>
          <span className="house-cell house-cell-life">Lifecycle</span>
          <span className="house-cell house-cell-state">Forge</span>
          <span className="house-cell house-cell-counts">bk / q / pr</span>
          <span className="house-cell house-cell-gap">Next</span>
          <span className="house-cell house-cell-cta" />
        </div>

        {p.projects.length === 0 ? (
          <div className="fleet-empty is-panel">
            <span className="fleet-empty-mark">
              <FolderGit2 />
            </span>
            <span className="fleet-empty-title">No repos at the house yet</span>
            <p className="fleet-empty-sub">
              Connect a repository and Brokk can pick up tasks, open PRs, and forge previews.
            </p>
            <span className="fleet-empty-action">
              <Button asChild>
                <Link href="/connect">+ Connect a repo</Link>
              </Button>
            </span>
          </div>
        ) : (
          <div className="house-list" ref={listRef} role="table">
            {p.projects.map((proj) => {
              const ts = p.tasksByProject.get(proj.id) ?? [];
              const c = (s: string) => ts.filter((x) => x.status === s).length;
              return (
                <ProjectRow
                  key={proj.id}
                  project={proj}
                  repo={p.repoById.get(proj.repositoryId)}
                  running={c("running")}
                  counts={c}
                  brief={p.briefsByProject[proj.id]}
                  attention={p.attentionOf(proj.id)}
                  pinned={p.pinnedIds.includes(proj.id)}
                  pinIndex={pinRank.get(proj.id) ?? null}
                  previewBusy={p.previewBusyId === proj.id}
                  onTogglePin={() => p.onTogglePin(proj.id)}
                  onQueueMissing={(text) => p.onQueueMissing(proj.id, text)}
                  onOpenChat={() => openAnvilChat(proj.id)}
                  onOpenPreview={() => p.onOpenPreview(proj.id)}
                  onOpenObjective={() => setObjectiveId(proj.id)}
                />
              );
            })}
          </div>
        )}
      </section>

      {objectiveProject ? (
        <ObjectivePanel
          projectId={objectiveProject.id}
          projectName={objectiveProject.name}
          lifecycle={projectLifecycle(objectiveProject)}
          objective={projectObjective(objectiveProject)}
          busy={p.houseBusyId === objectiveProject.id}
          onClose={() => setObjectiveId(null)}
          onSave={async (next) => {
            await p.onSaveHouse(objectiveProject.id, next);
            setObjectiveId(null);
            openAnvilChat(objectiveProject.id);
          }}
          onArchive={async () => {
            await p.onArchiveProject(objectiveProject.id);
            setObjectiveId(null);
          }}
        />
      ) : null}
      </div>

      <footer className="house-footer">
        <div className="house-footer-dock" aria-label="Recent sessions">
          <span className="house-footer-label">Sessions</span>
          {p.dockSessions.length === 0 ? (
            <span className="house-footer-empty">open a chat — it lands here</span>
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
        </div>

        <div className="house-footer-queue" aria-label="Global queue">
          <span className="house-footer-label">
            Queue
            {p.queue.length > 0 ? <em>{p.queue.length}</em> : null}
          </span>
          {p.queue.length === 0 ? (
            <span className="house-footer-empty">
              <Flame size={12} aria-hidden /> forge quiet
            </span>
          ) : (
            <div className="house-queue-strip">
              {p.queue.slice(0, 8).map((task) => {
                const proj = p.projectById.get(task.projectId);
                const isRunning = task.status === "running";
                return (
                  <Link
                    key={task.id}
                    href={`/projects/${task.projectId}`}
                    className={`house-queue-chip${isRunning ? " is-running" : ""}`}
                    title={task.title}
                  >
                    <span
                      className="fleet-row-dot"
                      style={{ background: STATUS_COLOR[task.status] }}
                    />
                    <span className="house-queue-proj">{proj?.name ?? "?"}</span>
                    <span className="house-queue-title">{task.title}</span>
                  </Link>
                );
              })}
              {p.queue.length > 8 ? (
                <span className="house-footer-empty">+{p.queue.length - 8}</span>
              ) : null}
            </div>
          )}
        </div>
      </footer>
    </main>
  );
}
