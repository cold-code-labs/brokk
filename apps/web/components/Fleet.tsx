"use client";

import type { Project, Repository, Subscription, Task } from "@brokk/sdk";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { brokk } from "../lib/api";
import { STATUS_COLOR, t } from "../lib/theme";

export default function Fleet() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [seats, setSeats] = useState<Subscription[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // composer
  const [pid, setPid] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

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

  const count = (s: string) => tasks.filter((x) => x.status === s).length;
  const activeSeats = seats.filter((s) => s.status === "active").length;
  const queue = tasks
    .filter((x) => x.status === "running" || x.status === "queued")
    .sort((a, b) => (a.status === "running" ? -1 : 1) - (b.status === "running" ? -1 : 1));

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
    <div style={{ padding: "28px 32px", maxWidth: 1200 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, letterSpacing: -0.4 }}>Fleet</h1>
          <p style={{ margin: "4px 0 0", color: t.textMuted, fontSize: 14 }}>The forge, across every CCL repo.</p>
        </div>
        <Link href="/connect" style={{ ...btnPrimary, textDecoration: "none" }}>+ Connect repos</Link>
      </header>

      {err && <p style={{ color: STATUS_COLOR.failed, fontSize: 13, margin: "0 0 12px" }}>⚠ {err}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 12, marginBottom: 24 }}>
        <Metric label="Running now" value={count("running")} color={STATUS_COLOR.running} />
        <Metric label="Queued" value={count("queued")} />
        <Metric label="In review · PR" value={count("review")} color={STATUS_COLOR.review} />
        <Metric label="Max seats" value={activeSeats} suffix="active" />
      </div>

      {/* composer */}
      <form onSubmit={createTask} style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        <select value={pid} onChange={(e) => setPid(e.target.value)} style={{ ...input, flex: "0 0 200px" }}>
          {projects.length === 0 && <option value="">no project — connect a repo</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task title…" style={{ ...input, flex: "1 1 360px" }} />
        <button type="submit" disabled={busy || !pid || !title.trim()} style={btnPrimary}>
          {busy ? "Forging…" : "Queue →"}
        </button>
      </form>

      <p style={sectionLabel}>Projects</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12, marginBottom: 24 }}>
        {projects.map((p) => {
          const ts = byProject.get(p.id) ?? [];
          const repo = repoById.get(p.repositoryId);
          const running = ts.filter((x) => x.status === "running").length;
          const c = (s: string) => ts.filter((x) => x.status === s).length;
          return (
            <Link key={p.id} href={`/projects/${p.id}`} style={projectCard}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</span>
                {running > 0 ? (
                  <span style={{ fontSize: 12, color: STATUS_COLOR.running }}>● {running} running</span>
                ) : (
                  <span style={{ fontSize: 12, color: t.textFaint }}>idle</span>
                )}
              </div>
              <p style={{ margin: "4px 0 12px", fontSize: 12, color: t.textFaint }}>
                {repo ? `${repo.fullName} · ${p.baseBranch}` : "—"}
              </p>
              <div style={{ display: "flex", gap: 6 }}>
                <Pill text={`${c("backlog")} backlog`} />
                <Pill text={`${c("queued")} queued`} color={c("queued") ? STATUS_COLOR.queued : undefined} />
                <Pill text={`${c("review")} PR`} color={c("review") ? STATUS_COLOR.review : undefined} />
              </div>
            </Link>
          );
        })}
        <Link href="/connect" style={connectCard}>+ Connect a repo</Link>
      </div>

      <p style={sectionLabel}>Global queue · next up across the fleet</p>
      <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, overflow: "hidden" }}>
        {queue.length === 0 && <p style={{ margin: 0, padding: "16px 18px", fontSize: 13, color: t.textFaint }}>Nothing queued — the forge is quiet.</p>}
        {queue.map((task) => {
          const proj = projectById.get(task.projectId);
          const repo = proj ? repoById.get(proj.repositoryId) : undefined;
          return (
            <Link key={task.id} href={`/projects/${task.projectId}`} style={queueRow}>
              <span style={{ width: 7, height: 7, borderRadius: 7, background: STATUS_COLOR[task.status], flexShrink: 0 }} />
              <span style={{ fontSize: 13, flex: 1, color: t.text }}>{task.title}</span>
              <span style={{ fontSize: 12, color: t.textFaint }}>{repo?.name ?? proj?.name ?? ""}</span>
              <span style={{ fontSize: 12, color: STATUS_COLOR[task.status], minWidth: 64, textAlign: "right" }}>{task.status}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function Metric({ label, value, color, suffix }: { label: string; value: number; color?: string; suffix?: string }) {
  return (
    <div style={{ background: t.surface, borderRadius: 10, padding: "14px 16px" }}>
      <p style={{ margin: 0, fontSize: 13, color: t.textMuted }}>{label}</p>
      <p style={{ margin: "2px 0 0", fontSize: 24, fontWeight: 600, color: color ?? t.text }}>
        {value}
        {suffix && <span style={{ fontSize: 13, color: t.textFaint, fontWeight: 400 }}> {suffix}</span>}
      </p>
    </div>
  );
}

function Pill({ text, color }: { text: string; color?: string }) {
  return (
    <span style={{ flex: 1, textAlign: "center", fontSize: 12, padding: "5px 0", borderRadius: 7, background: t.surface3, color: color ?? t.textMuted }}>
      {text}
    </span>
  );
}

const sectionLabel: React.CSSProperties = { margin: "0 0 8px", fontSize: 13, color: t.textMuted };
const input: React.CSSProperties = { background: t.surface, border: `1px solid ${t.border2}`, borderRadius: 8, padding: "9px 11px", color: t.text, fontSize: 13, minWidth: 140 };
const btnPrimary: React.CSSProperties = { background: t.accent, border: `1px solid ${t.border2}`, color: "#fff", borderRadius: 8, padding: "9px 14px", fontSize: 13, cursor: "pointer" };
const projectCard: React.CSSProperties = { display: "block", background: t.surface2, border: `1px solid ${t.border2}`, borderRadius: 12, padding: "14px 16px", textDecoration: "none", color: t.text };
const connectCard: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", border: `1px dashed ${t.border2}`, borderRadius: 12, padding: "14px 16px", textDecoration: "none", color: t.textMuted, fontSize: 13 };
const queueRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${t.border}`, textDecoration: "none" };
