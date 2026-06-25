"use client";

import type { Preview, Project, Repository, Subscription, Task } from "@brokk/sdk";
import { useEffect, useMemo, useState } from "react";
import { brokk } from "../lib/api";
import "../app/fleet.css";
import FleetView from "./FleetView";

/** Brokk home — the Fleet: every connected CCL repo, its queue, the global
 *  queue, and Max seats. Data lives here; FleetView renders it. */
export default function Fleet() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [seats, setSeats] = useState<Subscription[]>([]);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [previewBusy, setPreviewBusy] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // composer
  const [pid, setPid] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [r, p, ts, s, pv] = await Promise.all([
        brokk.listRepositories(),
        brokk.listProjects(),
        brokk.listTasks(),
        brokk.listSubscriptions().catch(() => [] as Subscription[]),
        brokk.listPreviews().catch(() => [] as Preview[]),
      ]);
      setRepos(r);
      setProjects(p);
      setTasks(ts);
      setSeats(s);
      setPreviews(pv);
      if (!pid && p[0]) setPid(p[0].id);
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

  /** Most-recent active (starting|live) preview per project. */
  const previewsByProject = useMemo(() => {
    const m = new Map<string, Preview>();
    for (const pv of previews) {
      if (pv.status === "starting" || pv.status === "live") {
        const existing = m.get(pv.projectId);
        if (!existing || pv.createdAt > existing.createdAt) m.set(pv.projectId, pv);
      }
    }
    return m;
  }, [previews]);

  const count = (s: string) => tasks.filter((x) => x.status === s).length;
  const queue = useMemo(
    () =>
      tasks
        .filter((x) => x.status === "running" || x.status === "queued")
        .sort((a, b) => (a.status === "running" ? -1 : 1) - (b.status === "running" ? -1 : 1)),
    [tasks],
  );

  async function handlePreview(projectId: string) {
    setPreviewBusy((prev) => ({ ...prev, [projectId]: true }));
    try {
      const pv = await brokk.createPreview({ projectId });
      setPreviews((prev) => [
        ...prev.filter((x) => !(x.projectId === projectId && (x.status === "starting" || x.status === "live"))),
        pv,
      ]);
    } catch (e) {
      setErr(String(e));
    } finally {
      setPreviewBusy((prev) => ({ ...prev, [projectId]: false }));
    }
  }

  async function handleStopPreview(previewId: string) {
    try {
      await brokk.stopPreview(previewId);
      setPreviews((prev) => prev.filter((x) => x.id !== previewId));
    } catch (e) {
      setErr(String(e));
    }
  }

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    if (!pid || !title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const task = await brokk.createTask({ projectId: pid, title: title.trim() });
      await brokk.enqueueTask(task.id);
      setTitle("");
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
      projects={projects}
      repoById={repoById}
      projectById={projectById}
      tasksByProject={tasksByProject}
      queue={queue}
      previewsByProject={previewsByProject}
      previewBusy={previewBusy}
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
      onPid={setPid}
      onTitle={setTitle}
      onSubmit={createTask}
      onPreview={handlePreview}
      onStopPreview={handleStopPreview}
    />
  );
}
