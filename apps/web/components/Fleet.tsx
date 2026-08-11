"use client";

import type { Project, Repository, Subscription, Task } from "@brokk/sdk";
import { useEffect, useMemo, useState } from "react";
import { brokk } from "../lib/api";
import { discovery, type ProjectBrief } from "../lib/chat";
import { isSidecarProjectName } from "../lib/house";
import { useProject } from "../lib/project-context";
import "../app/fleet.css";
import FleetView, { type HouseBrief } from "./FleetView";

/** Brokk home — the House cockpit. Data here; FleetView renders the grid. */
export default function Fleet({ compact = false }: { compact?: boolean }) {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [seats, setSeats] = useState<Subscription[]>([]);
  const [briefsByProject, setBriefsByProject] = useState<Record<string, HouseBrief>>({});
  const [previewByProject, setPreviewByProject] = useState<
    Record<string, import("./FleetView").HousePreviewInfo>
  >({});
  const [err, setErr] = useState<string | null>(null);
  const [previewBusyId, setPreviewBusyId] = useState<string | null>(null);
  const [houseBusyId, setHouseBusyId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { setCurrentId } = useProject();

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
    let alive = true;
    (async () => {
      try {
        await brokk.syncFleet();
      } catch {
        /* Heimdall down / not configured — still show local projects */
      }
      if (alive) await load();
    })();
    const i = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(i);
    };
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
    if (projects.length === 0) return;
    let alive = true;
    const tick = async () => {
      const entries = await Promise.all(
        projects.map(async (proj) => {
          try {
            const ps = await brokk.listPreviews(proj.id);
            const live = ps.find((x) => x.status === "live") ?? null;
            return [
              proj.id,
              {
                live: Boolean(live),
                subdomain: live?.subdomain ?? null,
              },
            ] as const;
          } catch {
            return [proj.id, { live: false, subdomain: null }] as const;
          }
        }),
      );
      if (!alive) return;
      setPreviewByProject(Object.fromEntries(entries));
    };
    void tick();
    const i = setInterval(tick, 20_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [projects]);

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

  const count = (s: string) => tasks.filter((x) => x.status === s).length;
  const queue = useMemo(
    () =>
      tasks
        .filter((x) => x.status === "running" || x.status === "queued")
        .sort((a, b) => (a.status === "running" ? -1 : 1) - (b.status === "running" ? -1 : 1)),
    [tasks],
  );

  async function openPreview(projectId: string) {
    setErr(null);
    setPreviewBusyId(projectId);
    setCurrentId(projectId);
    try {
      const existing = await brokk.listPreviews(projectId);
      const active = existing.find((x) => x.status === "live" || x.status === "starting");
      const pv = active ?? (await brokk.createPreview({ projectId }));
      if (pv.subdomain) {
        setPreviewByProject((prev) => ({
          ...prev,
          [projectId]: {
            live: pv.status === "live",
            subdomain: pv.subdomain,
          },
        }));
        // Always via preview-gate (Logto → mint key) — never raw preview.url.
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

  const visibleProjects = projects.filter((p) => !isSidecarProjectName(p.name));

  return (
    <FleetView
      projects={visibleProjects}
      compact={compact}
      repoById={repoById}
      projectById={projectById}
      tasksByProject={tasksByProject}
      briefsByProject={briefsByProject}
      previewByProject={previewByProject}
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
      onOpenPreview={openPreview}
      onSaveHouse={saveHouse}
      onArchiveProject={archiveProject}
    />
  );
}
