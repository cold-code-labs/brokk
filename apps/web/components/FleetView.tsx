"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Columns3,
  Eye,
  Flame,
  FolderGit2,
  MessageSquare,
  MoreHorizontal,
  Pin,
  Target,
} from "lucide-react";
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

function statusLine(input: {
  needObj: boolean;
  running: number;
  review: number;
  queued: number;
  missing: string[];
  mission: string | null;
  objectiveSummary: string | null;
}): { tone: "need" | "run" | "review" | "gap" | "ok" | "idle"; text: string } {
  if (input.needObj) return { tone: "need", text: "Definir próximo objetivo" };
  if (input.running > 0) return { tone: "run", text: `${input.running} forjando agora` };
  if (input.review > 0) return { tone: "review", text: `${input.review} em review` };
  if (input.queued > 0) return { tone: "run", text: `${input.queued} na fila` };
  if (input.missing[0]) {
    const g = input.missing[0];
    return { tone: "gap", text: g.length > 72 ? `${g.slice(0, 70)}…` : g };
  }
  if (input.objectiveSummary) {
    const first = input.objectiveSummary.split("\n")[0]?.replace(/^Próximo objetivo:\s*/i, "") ?? "";
    if (first) return { tone: "ok", text: first.length > 72 ? `${first.slice(0, 70)}…` : first };
  }
  if (input.mission) {
    const m = input.mission;
    return { tone: "idle", text: m.length > 72 ? `${m.slice(0, 70)}…` : m };
  }
  return { tone: "idle", text: "Quiet — sem sinal recente" };
}

function ProjectCard({
  project,
  repo,
  running,
  counts,
  brief,
  pinned,
  pinIndex,
  previewBusy,
  menuOpen,
  onToggleMenu,
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
  pinned: boolean;
  pinIndex: number | null;
  previewBusy: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onTogglePin: () => void;
  onQueueMissing: (text: string) => void;
  onOpenChat: () => void;
  onOpenPreview: () => void;
  onOpenObjective: () => void;
}) {
  const missing = brief?.missing ?? [];
  const queued = counts("queued");
  const review = counts("review");
  const backlog = counts("backlog");
  const life = projectLifecycle(project);
  const obj = projectObjective(project);
  const needObj = needsObjective(project);
  const archived = life === "archived";
  const status = statusLine({
    needObj,
    running,
    review,
    queued,
    missing,
    mission: brief?.mission ?? null,
    objectiveSummary: obj?.summary ?? null,
  });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onToggleMenu();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen, onToggleMenu]);

  return (
    <article
      className={`house-card${running > 0 ? " is-running" : ""}${needObj ? " needs-objective" : ""}${
        archived ? " is-archived" : ""
      }`}
    >
      <header className="house-card-head">
        <button
          type="button"
          className={`fleet-pin-btn${pinned ? " is-on" : ""}`}
          aria-label={pinned ? "Unpin" : "Pin"}
          title={pinned ? (pinIndex != null ? `Pinned · key ${pinIndex}` : "Unpin") : "Pin"}
          onClick={onTogglePin}
        >
          <Pin size={13} strokeWidth={pinned ? 2.25 : 1.75} />
          {pinIndex != null ? <span className="house-pin-idx">{pinIndex}</span> : null}
        </button>
        <div className="house-card-titles">
          <Link href={`/projects/${project.id}`} className="house-card-name" title={project.name}>
            {project.name}
          </Link>
          <span className="house-card-repo" title={repo?.fullName}>
            {repo ? repo.fullName.split("/").pop() : "—"}
          </span>
        </div>
        <div className="house-card-menu" ref={menuRef}>
          <button
            type="button"
            className="house-ico"
            aria-label="Ações rápidas"
            aria-expanded={menuOpen}
            onClick={onToggleMenu}
          >
            <MoreHorizontal size={15} strokeWidth={1.75} />
          </button>
          {menuOpen ? (
            <div className="house-menu" role="menu">
              <button type="button" role="menuitem" onClick={onOpenObjective}>
                <Target size={14} /> Objetivo / próxima rodada
              </button>
              <button type="button" role="menuitem" onClick={onOpenChat}>
                <MessageSquare size={14} /> Chat
              </button>
              <Link href={`/projects/${project.id}`} role="menuitem" onClick={onToggleMenu}>
                <Columns3 size={14} /> Board
              </Link>
              <button type="button" role="menuitem" disabled={previewBusy} onClick={onOpenPreview}>
                <Eye size={14} /> Preview
              </button>
              {missing[0] ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onQueueMissing(missing[0]!);
                    onToggleMenu();
                  }}
                >
                  + Queue gap
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      <button
        type="button"
        className={`house-life house-life-${life}${needObj ? " is-need" : ""}`}
        onClick={onOpenObjective}
        title="Abrir objetivo desta rodada"
      >
        {LIFE_LABEL[life]}
      </button>

      <p className={`house-card-status tone-${status.tone}`}>{status.text}</p>

      <div className="house-card-meta">
        {running > 0 ? (
          <span className="fleet-card-state running">
            <span className="fleet-run-dot" />
            {running} run
          </span>
        ) : (
          <span className="fleet-card-state idle">idle</span>
        )}
        <EnvPrepBadge projectId={project.id} />
        <span className="house-card-counts" title="backlog / queued / review / gaps">
          {backlog}
          <em>bk</em> {queued}
          <em>q</em> {review}
          <em>pr</em>
          {missing.length ? (
            <>
              {" "}
              {missing.length}
              <em>gap</em>
            </>
          ) : null}
        </span>
      </div>

      <footer className="house-card-cta">
        <button type="button" className="house-ico" title="Objetivo" aria-label="Objetivo" onClick={onOpenObjective}>
          <Target size={15} strokeWidth={1.75} />
        </button>
        <button type="button" className="house-ico" title="Chat" aria-label="Chat" onClick={onOpenChat}>
          <MessageSquare size={15} strokeWidth={1.75} />
        </button>
        <Link href={`/projects/${project.id}`} className="house-ico" title="Board" aria-label="Board">
          <Columns3 size={15} strokeWidth={1.75} />
        </Link>
        <button
          type="button"
          className={`house-ico${previewBusy ? " is-busy" : ""}`}
          title="Preview"
          aria-label="Preview"
          disabled={previewBusy}
          onClick={onOpenPreview}
        >
          <Eye size={15} strokeWidth={1.75} />
        </button>
      </footer>
    </article>
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

/** House — alphabetical project grid + per-project objective round. */
export default function FleetView(p: FleetViewProps) {
  const running = p.counts.running;
  const router = useRouter();
  const { setCurrentId, getLastSession, pinnedProjects } = useProject();
  const [objectiveId, setObjectiveId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);

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

  const alphaProjects = useMemo(() => {
    const active = p.projects.filter((x) => projectLifecycle(x) !== "archived");
    const archived = p.projects.filter((x) => projectLifecycle(x) === "archived");
    const byName = (a: Project, b: Project) =>
      a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" });
    return [...active.sort(byName), ...archived.sort(byName)];
  }, [p.projects]);

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
            <span className="house-bar-hint">Pin · 1–9 · Objetivo = gate humano por projeto</span>
          )}
          <Button asChild>
            <Link href="/connect">+ Connect</Link>
          </Button>
        </div>
      </header>

      {p.err && <Banner tone="err">⚠ {p.err}</Banner>}

      <div className="house-body">
        <section className="house-grid-wrap" aria-label="Projects A–Z">
          <div className="house-grid-head">
            <span>
              Projetos
              <em className="house-list-meta">
                {alphaProjects.length} · A–Z
              </em>
            </span>
          </div>

          {alphaProjects.length === 0 ? (
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
            <div className="house-grid">
              {alphaProjects.map((proj) => {
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
                    pinned={p.pinnedIds.includes(proj.id)}
                    pinIndex={pinRank.get(proj.id) ?? null}
                    previewBusy={p.previewBusyId === proj.id}
                    menuOpen={menuId === proj.id}
                    onToggleMenu={() => setMenuId((cur) => (cur === proj.id ? null : proj.id))}
                    onTogglePin={() => p.onTogglePin(proj.id)}
                    onQueueMissing={(text) => p.onQueueMissing(proj.id, text)}
                    onOpenChat={() => openAnvilChat(proj.id)}
                    onOpenPreview={() => p.onOpenPreview(proj.id)}
                    onOpenObjective={() => {
                      setMenuId(null);
                      setObjectiveId(proj.id);
                    }}
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
            tasks={p.tasksByProject.get(objectiveProject.id) ?? []}
            mission={p.briefsByProject[objectiveProject.id]?.mission ?? null}
            missing={p.briefsByProject[objectiveProject.id]?.missing ?? []}
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
