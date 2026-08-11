"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
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
import {
  attentionScore,
  houseGroup,
  needsAttention,
  OP_STATUS_LABEL,
  opStatus,
  prettyProjectName,
  type OpStatus,
} from "../lib/house";
import { useCockpitOptional } from "../lib/cockpit-context";
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

/** Mini LP — mounts once when visible, then stays cached. */
function CardPreviewStage({
  subdomain,
  label,
  onOpen,
}: {
  subdomain: string;
  label: string;
  onOpen: () => void;
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
      <button
        type="button"
        className="house-card-stage-hit"
        onClick={onOpen}
        aria-label={`Abrir preview · ${label}`}
        title="Abrir preview"
      />
    </div>
  );
}

function objectiveSnippet(summary: string | null | undefined): string {
  if (!summary) return "";
  const first = summary.split("\n")[0]?.replace(/^Próximo objetivo:\s*/i, "") ?? "";
  return first.length > 96 ? `${first.slice(0, 94)}…` : first;
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
  selected,
  onSelect,
  onOpenChat,
  onOpenPreview,
  onOpenForge,
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
  selected: boolean;
  onSelect: () => void;
  onOpenChat: () => void;
  onOpenPreview: () => void;
  onOpenForge: () => void;
  onOpenObjective: () => void;
  onArchive: () => void;
}) {
  const missing = brief?.missing ?? [];
  const queued = counts("queued");
  const review = counts("review");
  const life = projectLifecycle(project);
  const obj = projectObjective(project);
  const needObj = needsObjective(project);
  const archived = life === "archived";
  const previewLive = Boolean(preview?.live && preview.subdomain);
  const briefFailed = brief?.status === "failed";
  const status: OpStatus = opStatus({
    needObjective: needObj,
    running,
    review,
    briefFailed,
  });
  const label = prettyProjectName(project.name);
  const repoLeaf = repo?.fullName?.split("/").pop() ?? "";
  const showRepo =
    Boolean(repoLeaf) && prettyProjectName(repoLeaf).toLowerCase() !== label.toLowerCase();
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

  const showPreviewBody = previewLive && !needObj && status !== "failed";
  const forgeBlocked = needObj && !archived;

  return (
    <article
      className={`house-card op-${status}${archived ? " is-archived" : ""}${
        previewLive ? " has-preview" : ""
      }${needObj ? " needs-objective" : ""}${selected ? " is-selected" : ""}`}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("button, a, [role='menu'], [role='menuitem']")) return;
        onSelect();
      }}
    >
      <header className="house-card-head">
        <div className="house-card-status-row">
          <span className={`house-op house-op-${status}`}>
            <span className="house-op-dot" aria-hidden />
            {OP_STATUS_LABEL[status]}
          </span>
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
                    <Archive size={14} /> Arquivar
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="house-card-titles">
          <button type="button" className="house-card-name" title={label} onClick={onSelect}>
            {label}
          </button>
          {showRepo ? (
            <span className="house-card-repo" title={repo?.fullName}>
              {repoLeaf}
            </span>
          ) : null}
        </div>
      </header>

      <div className="house-card-body">
        {needObj ? (
          <div className="house-card-gate">
            <span className="house-card-gate-kicker">Objetivo não definido</span>
            <p>A esteira fica bloqueada até o objetivo humano ser travado.</p>
            <Button size="sm" onClick={onOpenObjective} disabled={houseBusy}>
              Definir objetivo
            </Button>
          </div>
        ) : showPreviewBody && preview?.subdomain ? (
          <CardPreviewStage
            subdomain={preview.subdomain}
            label={label}
            onOpen={onOpenPreview}
          />
        ) : (
          <div className="house-card-signals">
            {status === "failed" ? (
              <p className="house-signal-lead is-fail">Preview / ambiente com falha</p>
            ) : (
              <p className="house-signal-lead">
                {previewBusy
                  ? "Subindo preview…"
                  : previewLive
                    ? "Sinais da esteira"
                    : "Preview offline"}
              </p>
            )}
            <ul className="house-signal-list">
              {running > 0 ? <li>{running} forjando agora</li> : null}
              {queued > 0 ? <li>{queued} na fila</li> : null}
              {review > 0 ? <li>{review} em review</li> : null}
              {missing.length > 0 ? (
                <li>
                  {missing.length} gap{missing.length === 1 ? "" : "s"} Huginn
                </li>
              ) : null}
              {running === 0 && queued === 0 && review === 0 && missing.length === 0 ? (
                <li className="is-quiet">Sem sinal forte — quiet</li>
              ) : null}
            </ul>
          </div>
        )}
      </div>

      <div className="house-card-objective">
        {life !== "undocumented" && life !== "archived" ? (
          <span className={`house-life house-life-${life}`}>{LIFE_LABEL[life]}</span>
        ) : null}
        {needObj ? null : obj?.summary ? (
          <p className="house-obj-text" title={obj.summary}>
            <span className="house-obj-kicker">Objetivo</span>
            {objectiveSnippet(obj.summary)}
          </p>
        ) : brief?.mission ? (
          <p className="house-obj-text" title={brief.mission}>
            <span className="house-obj-kicker">Missão</span>
            {objectiveSnippet(brief.mission)}
          </p>
        ) : (
          <p className="house-obj-text is-muted">Sem objetivo narrado nesta rodada.</p>
        )}
      </div>

      <footer className="house-card-actions">
        <button type="button" className="house-act" onClick={onOpenChat}>
          <MessageSquare size={14} strokeWidth={1.75} /> Chat
        </button>
        <button
          type="button"
          className="house-act"
          disabled={previewBusy}
          onClick={onOpenPreview}
        >
          <Eye size={14} strokeWidth={1.75} /> Preview
        </button>
        <button
          type="button"
          className="house-act"
          disabled={forgeBlocked}
          title={forgeBlocked ? "Forge bloqueado até definir objetivo" : "Abrir Forge"}
          onClick={onOpenForge}
        >
          <Columns3 size={14} strokeWidth={1.75} /> Forge
        </button>
      </footer>
    </article>
  );
}

export interface FleetViewProps {
  projects: Project[];
  compact?: boolean;
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
  onOpenPreview: (projectId: string, opts?: { openTab?: boolean }) => void;
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

function Section({
  id,
  title,
  count,
  tone,
  children,
  empty,
}: {
  id: string;
  title: string;
  count: number;
  tone?: "attention" | "clients" | "internal";
  children: ReactNode;
  empty?: string;
}) {
  return (
    <section className={`house-section${tone ? ` is-${tone}` : ""}`} aria-labelledby={id}>
      <header className="house-section-head">
        <h2 id={id} className="house-section-title">
          {title}
        </h2>
        <em className="house-list-meta">{count}</em>
      </header>
      {count === 0 ? (
        empty ? <p className="house-group-empty">{empty}</p> : null
      ) : (
        <div className="house-grid">{children}</div>
      )}
    </section>
  );
}

/** House — mapa operacional da oficina (atenção → clientes → frota). */
export default function FleetView(p: FleetViewProps) {
  const running = p.counts.running;
  const router = useRouter();
  const { currentId, setCurrentId, getLastSession, pinnedProjects } = useProject();
  const cockpit = useCockpitOptional();
  const [objectiveId, setObjectiveId] = useState<string | null>(null);

  function openAnvilChat(projectId: string) {
    setCurrentId(projectId);
    if (cockpit) {
      cockpit.openProjectChat(projectId);
      cockpit.setStageMode("house");
      return;
    }
    const sid = getLastSession(projectId);
    router.push(sid ? `/chat?session=${encodeURIComponent(sid)}` : "/chat");
  }

  function openPreviewStage(projectId: string) {
    setCurrentId(projectId);
    if (cockpit) {
      cockpit.setStageMode("preview");
      void p.onOpenPreview(projectId, { openTab: false });
      return;
    }
    void p.onOpenPreview(projectId, { openTab: true });
  }

  function openForgeStage(projectId: string) {
    setCurrentId(projectId);
    if (cockpit) {
      cockpit.setStageMode("forge");
      return;
    }
    router.push(`/projects/${projectId}`);
  }

  const objectiveProject = objectiveId
    ? p.projects.find((x) => x.id === objectiveId) ?? null
    : null;

  const activeProjects = useMemo(
    () => p.projects.filter((x) => projectLifecycle(x) !== "archived"),
    [p.projects],
  );
  const archivedProjects = useMemo(() => {
    const byName = (a: Project, b: Project) =>
      prettyProjectName(a.name).localeCompare(prettyProjectName(b.name), "pt-BR", {
        sensitivity: "base",
      });
    return p.projects.filter((x) => projectLifecycle(x) === "archived").sort(byName);
  }, [p.projects]);

  const projectMeta = useMemo(() => {
    const m = new Map<
      string,
      { running: number; review: number; briefFailed: boolean; needObj: boolean }
    >();
    for (const proj of p.projects) {
      const ts = p.tasksByProject.get(proj.id) ?? [];
      m.set(proj.id, {
        running: ts.filter((t) => t.status === "running").length,
        review: ts.filter((t) => t.status === "review").length,
        briefFailed: p.briefsByProject[proj.id]?.status === "failed",
        needObj: needsObjective(proj),
      });
    }
    return m;
  }, [p.projects, p.tasksByProject, p.briefsByProject]);

  const attentionProjects = useMemo(() => {
    const hot = activeProjects.filter((proj) => {
      const meta = projectMeta.get(proj.id)!;
      return needsAttention({
        needObjective: meta.needObj,
        running: meta.running,
        review: meta.review,
        briefFailed: meta.briefFailed,
      });
    });
    return [...hot].sort((a, b) => {
      const sa = attentionScore(
        p.tasksByProject.get(a.id) ?? [],
        p.briefsByProject[a.id]
          ? {
              status: p.briefsByProject[a.id]!.status,
              missing: p.briefsByProject[a.id]!.missing,
              running: p.briefsByProject[a.id]!.running,
            }
          : null,
        projectLifecycle(a),
      );
      const sb = attentionScore(
        p.tasksByProject.get(b.id) ?? [],
        p.briefsByProject[b.id]
          ? {
              status: p.briefsByProject[b.id]!.status,
              missing: p.briefsByProject[b.id]!.missing,
              running: p.briefsByProject[b.id]!.running,
            }
          : null,
        projectLifecycle(b),
      );
      if (sb !== sa) return sb - sa;
      return prettyProjectName(a.name).localeCompare(prettyProjectName(b.name), "pt-BR", {
        sensitivity: "base",
      });
    });
  }, [activeProjects, projectMeta, p.tasksByProject, p.briefsByProject]);

  const attentionIds = useMemo(
    () => new Set(attentionProjects.map((x) => x.id)),
    [attentionProjects],
  );

  const byName = (a: Project, b: Project) =>
    prettyProjectName(a.name).localeCompare(prettyProjectName(b.name), "pt-BR", {
      sensitivity: "base",
    });

  const clientProjects = useMemo(
    () =>
      activeProjects
        .filter((x) => houseGroup(x.name) === "clients" && !attentionIds.has(x.id))
        .sort(byName),
    [activeProjects, attentionIds],
  );
  const internalProjects = useMemo(
    () =>
      activeProjects
        .filter((x) => houseGroup(x.name) === "internal" && !attentionIds.has(x.id))
        .sort(byName),
    [activeProjects, attentionIds],
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
        selected={currentId === proj.id}
        onSelect={() => openAnvilChat(proj.id)}
        onOpenChat={() => openAnvilChat(proj.id)}
        onOpenPreview={() => openPreviewStage(proj.id)}
        onOpenForge={() => openForgeStage(proj.id)}
        onOpenObjective={() => {
          setCurrentId(proj.id);
          setObjectiveId(proj.id);
        }}
        onArchive={() => void p.onArchiveProject(proj.id)}
      />
    );
  }

  return (
    <main
      className={`fleet forge-room is-house is-v2${objectiveProject ? " has-obj" : ""}${
        p.compact ? " is-compact" : ""
      }`}
    >
      <header className="house-bar">
        <div className="house-bar-brand">
          <h1 className="house-bar-title">House</h1>
          <span className={`fleet-pulse${running > 0 ? "" : " is-quiet"}`}>
            <span className="fleet-ember" />
            {running > 0
              ? `${running} forjando · ${p.counts.queued} na fila · ${p.counts.review} review`
              : attentionProjects.length > 0
                ? `${attentionProjects.length} precisam de atenção`
                : "oficina quiet"}
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
        </div>
      </header>

      {p.err && <Banner tone="err">⚠ {p.err}</Banner>}

      <div className="house-body">
        {activeProjects.length === 0 && archivedProjects.length === 0 ? (
          <section className="house-grid-wrap" aria-label="Projects">
            <div className="fleet-empty is-panel">
              <span className="fleet-empty-mark">
                <FolderGit2 />
              </span>
              <span className="fleet-empty-title">Nenhum projeto na House</span>
              <p className="fleet-empty-sub">
                Conecte um repositório ou aguarde o sync da frota Heimdall.
              </p>
              <span className="fleet-empty-action">
                <Button asChild>
                  <Link href="/connect">+ Connect a repo</Link>
                </Button>
              </span>
            </div>
          </section>
        ) : (
          <div className="house-stack" aria-label="Mapa operacional">
            {attentionProjects.length > 0 ? (
              <Section
                id="house-attention"
                title="Precisa de atenção"
                count={attentionProjects.length}
                tone="attention"
              >
                {attentionProjects.map(renderCard)}
              </Section>
            ) : null}

            <Section
              id="house-group-clients"
              title="Clientes CCL"
              count={clientProjects.length}
              tone="clients"
              empty="Nenhum cliente quiet neste momento"
            >
              {clientProjects.map(renderCard)}
            </Section>

            <Section
              id="house-group-internal"
              title="Frota Interna"
              count={internalProjects.length}
              tone="internal"
              empty="Nada quiet na frota interna"
            >
              {internalProjects.map(renderCard)}
            </Section>

            {archivedProjects.length > 0 ? (
              <Section
                id="house-archived"
                title="Arquivados"
                count={archivedProjects.length}
              >
                {archivedProjects.map(renderCard)}
              </Section>
            ) : null}
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

      <footer className="house-footer is-queue-only" aria-label="Fila global">
        <span className="house-footer-label">
          Fila
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
                <button
                  key={task.id}
                  type="button"
                  className={`house-queue-chip${isRunning ? " is-running" : ""}`}
                  title={task.title}
                  onClick={() => openForgeStage(task.projectId)}
                >
                  <span
                    className="fleet-row-dot"
                    style={{ background: STATUS_COLOR[task.status] }}
                  />
                  <span className="house-queue-proj">
                    {proj ? prettyProjectName(proj.name) : "?"}
                  </span>
                  <span className="house-queue-title">{task.title}</span>
                </button>
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
