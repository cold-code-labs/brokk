"use client";

import type { Project, Repository, Subscription, Task } from "@brokk/sdk";
import { useEffect, useMemo, useState } from "react";
import { brokk } from "../lib/api";
import { chat, discovery, type ChatSessionWithStats, type ProjectBrief } from "../lib/chat";
import {
  attentionScore,
  sortByAttention,
  type BriefSnapshot,
} from "../lib/house";
import { useProject } from "../lib/project-context";
import "../app/fleet.css";
import FleetView, { type DockSession, type HouseBrief } from "./FleetView";

/** Brokk home — the House cockpit: pins, attention board, intake, global queue.
 *  Data lives here; FleetView renders it. */
export default function Fleet() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [seats, setSeats] = useState<Subscription[]>([]);
  const [briefsByProject, setBriefsByProject] = useState<Record<string, HouseBrief>>({});
  const [dockSessions, setDockSessions] = useState<DockSession[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const {
    currentId,
    pinnedIds,
    togglePin,
    getDraft,
    setDraft,
    getLastSession,
    setCurrentId,
  } = useProject();
  const [pid, setPid] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  // Sync composer project + draft when anvil / pin changes.
  useEffect(() => {
    if (!currentId) return;
    setPid((prev) => {
      if (prev === currentId) return prev;
      return currentId;
    });
  }, [currentId]);

  useEffect(() => {
    if (!pid) return;
    setTitle(getDraft(pid));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  function onPid(id: string) {
    if (pid && title.trim()) setDraft(pid, title);
    setPid(id);
    setCurrentId(id);
  }

  function onTitle(v: string) {
    setTitle(v);
    if (pid) setDraft(pid, v);
  }

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
      if (!pid && p[0]) {
        const active = currentId && p.some((x) => x.id === currentId) ? currentId : p[0].id;
        setPid(active);
      }
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    load();
    const i = setInterval(load, 4000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Huginn briefs — refresh slower than the task poll (briefs change rarely).
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

  // Session dock — last sessions for pinned projects (fall back to recent of each).
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
      scores.set(proj.id, attentionScore(ts, snap));
    }
    return (id: string) => scores.get(id) ?? 0;
  }, [projects, tasksByProject, briefsByProject]);

  const sortedProjects = useMemo(
    () => sortByAttention(projects, scoreOf),
    [projects, scoreOf],
  );

  const count = (s: string) => tasks.filter((x) => x.status === s).length;
  const queue = useMemo(
    () =>
      tasks
        .filter((x) => x.status === "running" || x.status === "queued")
        .sort((a, b) => (a.status === "running" ? -1 : 1) - (b.status === "running" ? -1 : 1)),
    [tasks],
  );

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    if (!pid || !title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const task = await brokk.createTask({ projectId: pid, title: title.trim() });
      await brokk.enqueueTask(task.id);
      setTitle("");
      setDraft(pid, "");
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) return null;

  return (
    <FleetView
      projects={sortedProjects}
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
      pid={pid}
      title={title}
      busy={busy}
      onPid={onPid}
      onTitle={onTitle}
      onSubmit={createTask}
      onQueueMissing={(projectId, missing) => {
        if (pid && title.trim()) setDraft(pid, title);
        setPid(projectId);
        setCurrentId(projectId);
        setTitle(missing);
        setDraft(projectId, missing);
      }}
    />
  );
}
