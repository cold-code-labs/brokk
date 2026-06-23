"use client";

import type { Preview, Project, Repository, Subscription, Task } from "@brokk/sdk";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Main,
  PageHeader,
  Section,
  StatStrip,
  Stat,
  Banner,
  Button,
} from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { STATUS_COLOR } from "../lib/theme";
import { PreviewChip } from "./PreviewChip";

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
  const byProject = useMemo(() => {
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
        if (!existing || pv.createdAt > existing.createdAt) {
          m.set(pv.projectId, pv);
        }
      }
    }
    return m;
  }, [previews]);

  const count = (s: string) => tasks.filter((x) => x.status === s).length;
  const activeSeats = seats.filter((s) => s.status === "active").length;
  const queue = tasks
    .filter((x) => x.status === "running" || x.status === "queued")
    .sort((a, b) => (a.status === "running" ? -1 : 1) - (b.status === "running" ? -1 : 1));

  async function handlePreview(projectId: string) {
    setPreviewBusy((prev) => ({ ...prev, [projectId]: true }));
    try {
      const pv = await brokk.createPreview({ projectId });
      // Replace any existing active preview for this project with the new one.
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
    <Main style={{ maxWidth: "72rem" }}>
      <PageHeader
        title="Fleet"
        description="The forge, across every CCL repo."
        actions={
          <Button asChild>
            <Link href="/connect">+ Connect repos</Link>
          </Button>
        }
      />

      {err && <Banner tone="err">⚠ {err}</Banner>}

      <StatStrip>
        <Stat value={count("running")} label="Running now" tone="info" dot />
        <Stat value={count("queued")} label="Queued" />
        <Stat value={count("review")} label="In review · PR" tone="info" dot />
        <Stat value={activeSeats} label="Max seats" />
      </StatStrip>

      {/* composer */}
      <form onSubmit={createTask} style={{ display: "flex", gap: 8, marginBottom: "2rem", flexWrap: "wrap" }}>
        <select value={pid} onChange={(e) => setPid(e.target.value)} style={{ ...field, flex: "0 0 200px" }}>
          {projects.length === 0 && <option value="">no project — connect a repo</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task title…" style={{ ...field, flex: "1 1 360px" }} />
        <Button type="submit" disabled={busy || !pid || !title.trim()}>
          {busy ? "Forging…" : "Queue →"}
        </Button>
      </form>

      <Section title="Projects">
        <div className="ygg-card-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 22rem), 1fr))" }}>
          {projects.map((p) => {
            const ts = byProject.get(p.id) ?? [];
            const repo = repoById.get(p.repositoryId);
            const running = ts.filter((x) => x.status === "running").length;
            const c = (s: string) => ts.filter((x) => x.status === s).length;
            const activePreview = previewsByProject.get(p.id);
            return (
              <div key={p.id} className="ygg-card">
                <Link href={`/projects/${p.id}`} style={{ display: "block", textDecoration: "none", color: "inherit" }}>
                  <div className="ygg-card-title">
                    {p.name}
                    {running > 0 ? (
                      <span style={{ fontSize: "0.8rem", color: STATUS_COLOR.running }}>● {running} running</span>
                    ) : (
                      <span className="ygg-dim" style={{ fontSize: "0.8rem" }}>idle</span>
                    )}
                  </div>
                  <p className="ygg-dim" style={{ margin: "0.3rem 0 0.85rem", fontSize: "0.8rem" }}>
                    {repo ? `${repo.fullName} · ${p.baseBranch}` : "—"}
                  </p>
                </Link>
                <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                  <span className="ygg-badge">{c("backlog")} backlog</span>
                  <span className="ygg-badge" data-tone={c("queued") ? "warn" : undefined}>{c("queued")} queued</span>
                  <span className="ygg-badge" data-tone={c("review") ? "info" : undefined}>{c("review")} PR</span>
                </div>
                <div style={{ display: "flex", alignItems: "center" }}>
                  {activePreview ? (
                    <PreviewChip preview={activePreview} onStop={() => handleStopPreview(activePreview.id)} />
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      onClick={() => handlePreview(p.id)}
                      disabled={!!previewBusy[p.id]}
                    >
                      {previewBusy[p.id] ? "starting…" : "Preview dev"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          <Link
            href="/connect"
            className="ygg-card"
            style={{ display: "grid", placeItems: "center", borderStyle: "dashed", color: "var(--fg-soft)", textDecoration: "none", animation: "none" }}
          >
            + Connect a repo
          </Link>
        </div>
      </Section>

      <Section title="Global queue · next up across the fleet">
        <div className="ygg-card" style={{ padding: 0, overflow: "hidden", animation: "none" }}>
          {queue.length === 0 && (
            <p className="ygg-dim" style={{ margin: 0, padding: "1rem 1.15rem", fontSize: "0.85rem" }}>
              Nothing queued — the forge is quiet.
            </p>
          )}
          {queue.map((task) => {
            const proj = projectById.get(task.projectId);
            const repo = proj ? repoById.get(proj.repositoryId) : undefined;
            return (
              <Link key={task.id} href={`/projects/${task.projectId}`} style={queueRow}>
                <span style={{ width: 7, height: 7, borderRadius: 7, background: STATUS_COLOR[task.status], flexShrink: 0 }} />
                <span style={{ fontSize: "0.85rem", flex: 1, color: "var(--fg)" }}>{task.title}</span>
                <span className="ygg-dim" style={{ fontSize: "0.8rem" }}>{repo?.name ?? proj?.name ?? ""}</span>
                <span style={{ fontSize: "0.8rem", color: STATUS_COLOR[task.status], minWidth: 64, textAlign: "right" }}>{task.status}</span>
              </Link>
            );
          })}
        </div>
      </Section>
    </Main>
  );
}

const field: React.CSSProperties = {
  background: "var(--bg-soft)",
  border: "1px solid var(--line)",
  borderRadius: "0.55rem",
  padding: "0.55rem 0.7rem",
  color: "var(--fg)",
  font: "inherit",
  fontSize: "0.9rem",
  minWidth: 140,
};
const queueRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0.7rem 1rem",
  borderBottom: "1px solid var(--line-soft)",
  textDecoration: "none",
};
