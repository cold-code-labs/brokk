"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  BarChart3,
  Columns3,
  Eye,
  Flame,
  FolderGit2,
  MessageSquare,
  MoreHorizontal,
  Target,
} from "lucide-react";
import { Button, Banner } from "@cold-code-labs/yggdrasil-react";
import type { HouseLifecycle, HouseObjective } from "@brokk/core";
import { STATUS_COLOR } from "../lib/theme";
import { type BriefStatus } from "../lib/chat";
import { houseGroup, prettyProjectName } from "../lib/house";
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

const LIFE_LABEL: Record<Exclude<HouseLifecycle, "undocumented">, string> = {
  prototype: "Protótipo",
  working: "Trabalhando",
  archived: "Arquivado",
};

export type HouseBrief = {
  status: BriefStatus | null;
  missing: string[];
  running: boolean;
  mission: string | null;
};

/** Live preview handle for a House card (subdomain → /preview-gate). */
export type HousePreviewInfo = {
  live: boolean;
  subdomain: string | null;
};

function statusLine(input: {
  needObj: boolean;
  running: number;
  review: number;
  queued: number;
  missing: string[];
  mission: string | null;
  objectiveSummary: string | null;
}): { tone: "run" | "review" | "gap" | "ok" | "idle"; text: string } | null {
  if (input.needObj) return null;
  if (input.running > 0) return { tone: "run", text: `${input.running} forjando agora` };
  if (input.review > 0) return { tone: "review", text: `${input.review} em review` };
  if (input.queued > 0) return { tone: "run", text: `${input.queued} na fila` };
  if (input.missing[0]) {
    const g = input.missing[0];
    return { tone: "gap", text: g.length > 72 ? `${g.slice(0, 70)}…` : g };
  }
  if (input.objectiveSummary) {
    const first =
      input.objectiveSummary.split("\n")[0]?.replace(/^Próximo objetivo:\s*/i, "") ?? "";
    if (first) return { tone: "ok", text: first.length > 72 ? `${first.slice(0, 70)}…` : first };
  }
  if (input.mission) {
    const m = input.mission;
    return { tone: "idle", text: m.length > 72 ? `${m.slice(0, 70)}…` : m };
  }
  return null;
}

/** Mini LP — mounts once when visible, then stays cached across mode switches. */
function CardPreviewStage({
  subdomain,
  label,
  onOpen,
  interactive,
}: {
  subdomain: string;
  label: string;
  onOpen: () => void;
  interactive: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || mount) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setMount(true);
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mount]);

  return (
    <div className="house-card-stage" ref={ref}>
      {mount ? (
        <iframe
          className="house-card-frame"
          title={`Preview · ${label}`}
          src={`/preview-gate/${encodeURIComponent(subdomain)}`}
          loading="lazy"
          referrerPolicy="no-referrer"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
          tabIndex={-1}
        />
      ) : (
        <span className="house-card-stage-ph">carregando LP…</span>
      )}
      {interactive ? (
        <button
          type="button"
          className="house-card-stage-hit"
          onClick={onOpen}
          aria-label={`Abrir preview · ${label}`}
          title="Abrir o preview que está na telinha"
        />
      ) : null}
    </div>
  );
}

type CardMode = "preview" | "stats";
type BorderTone = "run" | "idle" | "fail";

function cardBorderTone(input: {
  running: number;
  briefFailed: boolean;
}): BorderTone {
  if (input.briefFailed) return "fail";
  if (input.running > 0) return "run";
  return "idle";
}

function ProjectCard({
  project,
  repo,
  running,
  counts,
  brief,
  previewBusy,
  preview,
  houseBusy,
  onOpenChat,
  onOpenPreview,
  onOpenObjective,
  onArchive,
}: {
  project: Project;
  repo?: Repository;
  running: number;
  counts: (s: string) => number;
  brief?: HouseBrief;
  previewBusy: boolean;
  preview: HousePreviewInfo | undefined;
  houseBusy: boolean;
  onOpenChat: () => void;
  onOpenPreview: () => void;
  onOpenObjective: () => void;
  onArchive: () => void;
}) {
  const missing = brief?.missing ?? [];
  const queued = counts("queued");
  const review = counts("review");
  const backlog = counts("backlog");
  const done = counts("done");
  const life = projectLifecycle(project);
  const obj = projectObjective(project);
  const needObj = needsObjective(project);
  const archived = life === "archived";
  const previewLive = Boolean(preview?.live && preview.subdomain);
  const briefFailed = brief?.status === "failed";
  const border = cardBorderTone({ running, briefFailed });
  const status = statusLine({
    needObj,
    running,
    review,
    queued,
    missing,
    mission: brief?.mission ?? null,
    objectiveSummary: obj?.summary ?? null,
  });
  const label = prettyProjectName(project.name);
  const repoLeaf = repo?.fullName?.split("/").pop() ?? "";
  const showRepo =
    Boolean(repoLeaf) && prettyProjectName(repoLeaf).toLowerCase() !== label.toLowerCase();
  const [mode, setMode] = useState<CardMode>("preview");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  return (
    <article
      className={`house-card tone-${border} mode-${mode}${archived ? " is-archived" : ""}${
        previewLive ? " has-preview" : ""
      }${needObj ? " needs-objective" : ""}`}
    >
      <header className="house-card-head">
        <div className="house-card-titles">
          <Link href={`/projects/${project.id}`} className="house-card-name" title={label}>
            {label}
          </Link>
          {showRepo ? (
            <span className="house-card-repo" title={repo?.fullName}>
              {repoLeaf}
            </span>
          ) : null}
        </div>
        <div className="house-card-head-actions">
          <button
            type="button"
            className="house-ico"
            title={mode === "preview" ? "Ver stats" : "Ver preview"}
            aria-label={mode === "preview" ? "Trocar para stats" : "Trocar para preview"}
            onClick={() => setMode((m) => (m === "preview" ? "stats" : "preview"))}
          >
            {mode === "preview" ? (
              <BarChart3 size={15} strokeWidth={1.75} />
            ) : (
              <span className="house-mode-eye">
                <Eye size={15} strokeWidth={1.75} />
                {previewLive ? <span className="house-preview-live" aria-hidden /> : null}
              </span>
            )}
          </button>
          <div className="house-card-menu" ref={menuRef}>
            <button
              type="button"
              className="house-ico"
              aria-label="Mais ações"
              aria-expanded={menuOpen}
              title="Mais ações"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MoreHorizontal size={15} strokeWidth={1.75} />
            </button>
            {menuOpen ? (
              <div className="house-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenObjective();
                  }}
                >
                  <Target size={14} /> Objetivo / rodada
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenChat();
                  }}
                >
                  <MessageSquare size={14} /> Chat
                </button>
                <Link
                  href={`/projects/${project.id}`}
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                >
                  <Columns3 size={14} /> Board
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  disabled={previewBusy}
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenPreview();
                  }}
                >
                  <Eye size={14} /> Abrir preview
                </button>
                {!archived ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    disabled={houseBusy}
                    onClick={() => {
                      setMenuOpen(false);
                      onArchive();
                    }}
                  >
                    <Archive size={14} /> Arquivar projeto
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="house-card-body">
        {/* Keep live iframe mounted (hidden) so stats↔preview doesn't reload the LP. */}
        {previewLive && preview?.subdomain ? (
          <div
            className={`house-preview-cache${mode === "preview" ? " is-on" : ""}`}
            aria-hidden={mode !== "preview"}
          >
            <CardPreviewStage
              subdomain={preview.subdomain}
              label={label}
              onOpen={onOpenPreview}
              interactive={mode === "preview"}
            />
          </div>
        ) : null}

        {mode === "preview" && !previewLive ? (
          <div className="house-card-stage is-empty">
            <p className="house-card-status">
              {briefFailed
                ? "Ambiente com falha — menu → Abrir preview"
                : previewBusy
                  ? "Subindo preview…"
                  : "Sem preview ao vivo — menu → Abrir preview"}
            </p>
          </div>
        ) : null}

        {mode === "stats" ? (
          <div className="house-card-stats">
            <div className="house-stats-top">
              {briefFailed ? (
                <span className="house-stats-pill is-fail">Falha</span>
              ) : running > 0 ? (
                <span className="house-stats-pill is-run">
                  <span className="fleet-run-dot" />
                  {running} forjando
                </span>
              ) : (
                <span className="house-stats-pill is-idle">Idle</span>
              )}
              {life !== "undocumented" ? (
                <button
                  type="button"
                  className={`house-life house-life-${life}`}
                  onClick={onOpenObjective}
                  title="Abrir objetivo desta rodada"
                >
                  {LIFE_LABEL[life]}
                </button>
              ) : needObj ? (
                <button
                  type="button"
                  className="house-life house-life-undocumented is-need"
                  onClick={onOpenObjective}
                  title="Definir objetivo"
                >
                  Sem objetivo
                </button>
              ) : null}
            </div>

            <div className="house-stats-grid" aria-label="Contagens">
              <div className="house-stats-cell">
                <strong>{backlog}</strong>
                <span>backlog</span>
              </div>
              <div className={`house-stats-cell${queued ? " is-hot" : ""}`}>
                <strong>{queued}</strong>
                <span>fila</span>
              </div>
              <div className={`house-stats-cell${review ? " is-info" : ""}`}>
                <strong>{review}</strong>
                <span>review</span>
              </div>
              <div className="house-stats-cell">
                <strong>{done}</strong>
                <span>feitos</span>
              </div>
            </div>

            <div className="house-stats-signal">
              <span className="house-stats-label">Sinal</span>
              <p className={`house-card-status tone-${status?.tone ?? "ok"}`}>
                {status?.text ??
                  (needObj
                    ? "Próxima rodada ainda sem objetivo travado."
                    : "Quiet — sem sinal forte.")}
              </p>
            </div>

            {missing.length > 0 ? (
              <div className="house-stats-gaps">
                <span className="house-stats-label">
                  Gaps <em>{missing.length}</em>
                </span>
                <ul>
                  {missing.slice(0, 3).map((g) => (
                    <li key={g}>{g.length > 72 ? `${g.slice(0, 70)}…` : g}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="house-stats-quiet">Sem gaps Huginn no radar.</p>
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export interface FleetViewProps {
  projects: Project[];
  repoById: Map<string, Repository>;
  projectById: Map<string, Project>;
  tasksByProject: Map<string, Task[]>;
  briefsByProject: Record<string, HouseBrief>;
  previewByProject: Record<string, HousePreviewInfo>;
  queue: Task[];
  counts: { running: number; queued: number; review: number; seats: number };
  err: string | null;
  previewBusyId: string | null;
  houseBusyId: string | null;
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

  function openAnvilChat(projectId: string) {
    setCurrentId(projectId);
    const sid = getLastSession(projectId);
    router.push(sid ? `/chat?session=${encodeURIComponent(sid)}` : "/chat");
  }

  const objectiveProject = objectiveId
    ? p.projects.find((x) => x.id === objectiveId) ?? null
    : null;

  const alphaProjects = useMemo(() => {
    const active = p.projects.filter((x) => projectLifecycle(x) !== "archived");
    const archived = p.projects.filter((x) => projectLifecycle(x) === "archived");
    const byName = (a: Project, b: Project) =>
      prettyProjectName(a.name).localeCompare(prettyProjectName(b.name), "pt-BR", {
        sensitivity: "base",
      });
    return [...active.sort(byName), ...archived.sort(byName)];
  }, [p.projects]);

  const clientProjects = useMemo(
    () => alphaProjects.filter((x) => houseGroup(x.name) === "clients"),
    [alphaProjects],
  );
  const internalProjects = useMemo(
    () => alphaProjects.filter((x) => houseGroup(x.name) === "internal"),
    [alphaProjects],
  );

  function renderCard(proj: Project) {
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
        previewBusy={p.previewBusyId === proj.id}
        preview={p.previewByProject[proj.id]}
        houseBusy={p.houseBusyId === proj.id}
        onOpenChat={() => openAnvilChat(proj.id)}
        onOpenPreview={() => p.onOpenPreview(proj.id)}
        onOpenObjective={() => setObjectiveId(proj.id)}
        onArchive={() => void p.onArchiveProject(proj.id)}
      />
    );
  }

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
        </div>
        <div className="house-bar-actions">
          {pinnedProjects.length > 0 ? (
            <div className="fleet-pin-strip house-bar-pins" aria-label="Pinned">
              {pinnedProjects.map((proj, i) => {
                const ts = p.tasksByProject.get(proj.id) ?? [];
                const run = ts.filter((t) => t.status === "running").length;
                const label = prettyProjectName(proj.name);
                return (
                  <button
                    key={proj.id}
                    type="button"
                    className={`fleet-pin-chip${run > 0 ? " is-running" : ""}${
                      needsObjective(proj) ? " needs-objective" : ""
                    }`}
                    onClick={() => openAnvilChat(proj.id)}
                    title={`${label} · ${i + 1}`}
                  >
                    <kbd className="fleet-pin-key">{i + 1}</kbd>
                    <span className="fleet-pin-name">{label}</span>
                    {run > 0 ? <span className="fleet-run-dot" /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          <Button asChild>
            <Link href="/connect">+ Connect</Link>
          </Button>
        </div>
      </header>

      {p.err && <Banner tone="err">⚠ {p.err}</Banner>}

      <div className="house-body">
        {alphaProjects.length === 0 ? (
          <section className="house-grid-wrap" aria-label="Projects">
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
          </section>
        ) : (
          <div className="house-groups" aria-label="Projetos por grupo">
            <section className="house-group is-clients" aria-labelledby="house-group-clients">
              <header className="house-group-head">
                <h2 id="house-group-clients" className="house-group-title">
                  Clientes CCL
                </h2>
                <em className="house-list-meta">{clientProjects.length}</em>
              </header>
              {clientProjects.length === 0 ? (
                <p className="house-group-empty">Nenhum cliente nesta House ainda</p>
              ) : (
                <div className="house-grid">{clientProjects.map(renderCard)}</div>
              )}
            </section>

            <div className="house-groups-divider" aria-hidden />

            <section className="house-group is-internal" aria-labelledby="house-group-internal">
              <header className="house-group-head">
                <h2 id="house-group-internal" className="house-group-title">
                  Frota Interna
                </h2>
                <em className="house-list-meta">{internalProjects.length}</em>
              </header>
              {internalProjects.length === 0 ? (
                <p className="house-group-empty">Nada na frota interna</p>
              ) : (
                <div className="house-grid">{internalProjects.map(renderCard)}</div>
              )}
            </section>
          </div>
        )}

        {objectiveProject ? (
          <ObjectivePanel
            projectId={objectiveProject.id}
            projectName={prettyProjectName(objectiveProject.name)}
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

      <footer className="house-footer is-queue-only" aria-label="Global queue">
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
            {p.queue.slice(0, 16).map((task) => {
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
                  <span className="house-queue-proj">
                    {proj ? prettyProjectName(proj.name) : "?"}
                  </span>
                  <span className="house-queue-title">{task.title}</span>
                </Link>
              );
            })}
            {p.queue.length > 16 ? (
              <span className="house-footer-empty">+{p.queue.length - 16}</span>
            ) : null}
          </div>
        )}
      </footer>
    </main>
  );
}
