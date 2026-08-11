"use client";

import type { Project, Repository, Subscription, Task } from "@brokk/sdk";
import { useEffect, useMemo, useState } from "react";
import { brokk } from "../lib/api";
import { chat, discovery, type ChatSessionWithStats, type ProjectBrief } from "../lib/chat";
import {
  attentionScore,
  type BriefSnapshot,
} from "../lib/house";
import { useProject } from "../lib/project-context";
import "../app/fleet.css";
import FleetView, { type DockSession, type HouseBrief } from "./FleetView";

/** Brokk home — the House cockpit. Data here; FleetView renders the grid. */
export default function Fleet() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [seats, setSeats] = useState<Subscription[]>([]);
  const [briefsByProject, setBriefsByProject] = useState<Record<string, HouseBrief>>({});
  const [dockSessions, setDockSessions] = useState<DockSession[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [previewBusyId, setPreviewBusyId] = useState<string | null>(null);
  const [houseBusyId, setHouseBusyId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { pinnedIds, togglePin, getLastSession, setCurrentId } = useProject();

  async function load() {
    try {
      const [r, p, ts, s] = await Promise.all([
        brokk.listRepositories(),
        brokk.listProjects(),
        brokk.listTasks(),
        brokk.listSubscriptions().catch(() => [] as Subscription[]),
      ]);
      setRepos(r);
      setProjects(p);
      setTasks(ts);
      setSeats(s);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    load();
    const i = setInterval(load, 4000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    if (projects.length === 0) return;
    let alive = true;
    const tick = async () => {
      const entries = await Promise.all(
        projects.map(async (proj) => {
          try {
            const res = await discovery.get(proj.id);
            const brief: ProjectBrief | null = res.brief;
            const snap: HouseBrief = {
              status: brief?.status ?? null,
              missing: brief?.status === "ready" ? brief.missing.slice(0, 5) : [],
              running: res.running,
              mission: brief?.mission ?? null,
            };
            return [proj.id, snap] as const;
          } catch {
            return [proj.id, { status: null, missing: [], running: false, mission: null }] as const;
          }
        }),
      );
      if (!alive) return;
      setBriefsByProject(Object.fromEntries(entries));
    };
    void tick();
    const i = setInterval(tick, 30_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [projects]);

  useEffect(() => {
    const ids = pinnedIds.length > 0 ? pinnedIds : projects.slice(0, 6).map((p) => p.id);
    if (ids.length === 0) {
      setDockSessions([]);
      return;
    }
    let alive = true;
    (async () => {
      const rows: DockSession[] = [];
      await Promise.all(
        ids.map(async (projectId) => {
          const proj = projects.find((p) => p.id === projectId);
          if (!proj) return;
          try {
            const list = await chat.listSessions(projectId);
            const prefer = getLastSession(projectId);
            const pick: ChatSessionWithStats | undefined =
              (prefer ? list.find((s) => s.id === prefer) : undefined) ?? list[0];
            if (!pick) return;
            rows.push({
              sessionId: pick.id,
              projectId,
              projectName: proj.name,
              title: pick.title || "Untitled session",
              updatedAt: pick.updatedAt,
              turnState: pick.turnState,
            });
          } catch {
            /* ignore */
          }
        }),
      );
      if (!alive) return;
      rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      setDockSessions(rows);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedIds, projects, tasks.length]);

  const repoById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const tasksByProject = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const task of tasks) {
      const arr = m.get(task.projectId) ?? [];
      arr.push(task);
      m.set(task.projectId, arr);
    }
    return m;
  }, [tasks]);

  const scoreOf = useMemo(() => {
    const scores = new Map<string, number>();
    for (const proj of projects) {
      const ts = tasksByProject.get(proj.id) ?? [];
      const b = briefsByProject[proj.id];
      const snap: BriefSnapshot | null = b
        ? { status: b.status, missing: b.missing, running: b.running }
        : null;
      scores.set(proj.id, attentionScore(ts, snap, (proj as { houseLifecycle?: import("@brokk/core").HouseLifecycle }).houseLifecycle));
    }
    return (id: string) => scores.get(id) ?? 0;
  }, [projects, tasksByProject, briefsByProject]);

  const count = (s: string) => tasks.filter((x) => x.status === s).length;
  const queue = useMemo(
    () =>
      tasks
        .filter((x) => x.status === "running" || x.status === "queued")
        .sort((a, b) => (a.status === "running" ? -1 : 1) - (b.status === "running" ? -1 : 1)),
    [tasks],
  );

  async function queueMissing(projectId: string, missing: string) {
    setErr(null);
    setCurrentId(projectId);
    try {
      const task = await brokk.createTask({ projectId, title: missing.trim() });
      await brokk.enqueueTask(task.id);
      await load();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function openPreview(projectId: string) {
    setErr(null);
    setPreviewBusyId(projectId);
    setCurrentId(projectId);
    try {
      const existing = await brokk.listPreviews(projectId);
      const active = existing.find((x) => x.status === "live" || x.status === "starting");
      const pv = active ?? (await brokk.createPreview({ projectId }));
      if (pv.status === "live" && pv.url) {
        window.open(pv.url, "_blank", "noopener,noreferrer");
      } else if (pv.subdomain) {
        window.open(
          `/preview-gate/${encodeURIComponent(pv.subdomain)}`,
          "_blank",
          "noopener,noreferrer",
        );
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setPreviewBusyId(null);
    }
  }

  async function saveHouse(
    projectId: string,
    next: {
      houseLifecycle: import("@brokk/core").HouseLifecycle;
      houseObjective: import("@brokk/core").HouseObjective;
      chatBrief: string;
    },
  ) {
    setHouseBusyId(projectId);
    setErr(null);
    try {
      await brokk.patchProjectHouse(projectId, {
        houseLifecycle: next.houseLifecycle,
        houseObjective: next.houseObjective,
      });
      try {
        sessionStorage.setItem(
          "brokk.house.pendingBrief",
          JSON.stringify({ projectId, brief: next.chatBrief }),
        );
      } catch {
        /* ignore */
      }
      await load();
    } catch (e) {
      setErr(String(e));
      throw e;
    } finally {
      setHouseBusyId(null);
    }
  }

  async function archiveProject(projectId: string) {
    setHouseBusyId(projectId);
    setErr(null);
    try {
      await brokk.patchProjectHouse(projectId, { houseLifecycle: "archived" });
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setHouseBusyId(null);
    }
  }

  if (!mounted) return null;

  return (
    <FleetView
      projects={projects}
      repoById={repoById}
      projectById={projectById}
      tasksByProject={tasksByProject}
      briefsByProject={briefsByProject}
      attentionOf={scoreOf}
      pinnedIds={pinnedIds}
      onTogglePin={togglePin}
      dockSessions={dockSessions}
      queue={queue}
      counts={{
        running: count("running"),
        queued: count("queued"),
        review: count("review"),
        seats: seats.filter((s) => s.status === "active").length,
      }}
      err={err}
      previewBusyId={previewBusyId}
      houseBusyId={houseBusyId}
      onQueueMissing={queueMissing}
      onOpenPreview={openPreview}
      onSaveHouse={saveHouse}
      onArchiveProject={archiveProject}
    />
  );
}
