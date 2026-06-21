"use client";

import type { Project, Task } from "@brokk/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { brokk } from "../lib/api";

const STATUS_COLOR: Record<string, string> = {
  backlog: "#5c6575",
  queued: "#b08900",
  running: "#2f81f7",
  review: "#a371f7",
  done: "#2ea043",
  succeeded: "#2ea043",
  failed: "#f85149",
  cancelled: "#5c6575",
};

const STATS = [
  { key: "all", label: "Total" },
  { key: "running", label: "Running" },
  { key: "review", label: "In Review" },
  { key: "queued", label: "Queued" },
  { key: "done", label: "Done" },
  { key: "failed", label: "Failed" },
] as const;

export default function Dashboard() {
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const projectIdRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async (projectId?: string) => {
    try {
      setTasks(await brokk.listTasks(projectId));
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const projects = await brokk.listProjects();
        if (!alive) return;
        const p = projects[0] ?? null;
        setProject(p);
        projectIdRef.current = p?.id;
        await refresh(p?.id);
      } catch (e) {
        setErr(String(e));
      }
    })();
    const interval = setInterval(() => refresh(projectIdRef.current), 5_000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, refresh]);

  function count(key: string): number {
    if (key === "all") return tasks.length;
    return tasks.filter((t) => t.status === key).length;
  }

  // Active = running + queued combined; shown in the project subtitle.
  const activeCount = count("running") + count("queued");

  return (
    <main style={{ padding: "28px 32px", maxWidth: 1100, margin: "0 auto" }}>
      {/* Page header */}
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: -0.3 }}>
          Dashboard
        </h1>
        <p style={{ margin: "4px 0 0", color: "#9aa3b2", fontSize: 13 }}>
          {project ? (
            <>
              <span style={{ color: "#e6e8ee" }}>{project.name}</span>
              {" · "}
              <span>{activeCount} active</span>
            </>
          ) : (
            <em>Loading project…</em>
          )}
        </p>
      </header>

      {err && (
        <p style={{ color: "#f85149", fontSize: 13, marginBottom: 16 }}>⚠ {err}</p>
      )}

      {/* Big number stat cards */}
      <section style={{ marginBottom: 36 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            gap: 14,
          }}
        >
          {STATS.map((s) => (
            <StatCard
              key={s.key}
              label={s.label}
              value={count(s.key)}
              color={s.key === "all" ? "#e6e8ee" : STATUS_COLOR[s.key]}
            />
          ))}
        </div>
      </section>

      {/* Recent tasks list */}
      <section>
        <h2 style={sectionHead}>Recent tasks</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {tasks.length === 0 && (
            <p style={{ color: "#3f4654", fontSize: 13 }}>No tasks yet.</p>
          )}
          {tasks.slice(0, 12).map((task) => (
            <div key={task.id} style={taskRowStyle}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: STATUS_COLOR[task.status] ?? "#5c6575",
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, fontSize: 13, color: "#e6e8ee", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {task.title}
              </span>
              <span style={{ fontSize: 11, color: "#5c6575", textTransform: "uppercase", letterSpacing: 0.3, flexShrink: 0 }}>
                {task.status}
              </span>
              {task.prUrl && (
                <a
                  href={task.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 11, color: "#a371f7", textDecoration: "none", flexShrink: 0 }}
                >
                  PR ↗
                </a>
              )}
            </div>
          ))}
          {tasks.length > 12 && (
            <p style={{ fontSize: 12, color: "#9aa3b2", margin: "6px 0 0", textAlign: "center" }}>
              +{tasks.length - 12} more —{" "}
              <a href="/kanban" style={{ color: "#a371f7", textDecoration: "none" }}>
                view all in Kanban
              </a>
            </p>
          )}
        </div>
      </section>
    </main>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={statCardStyle}>
      <div
        style={{
          fontSize: 52,
          fontWeight: 700,
          color,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: -2,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "#6b7585",
          marginTop: 8,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        {label}
      </div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const statCardStyle: React.CSSProperties = {
  background: "#0f121a",
  border: "1px solid #1c212c",
  borderRadius: 12,
  padding: "22px 24px 20px",
};

const sectionHead: React.CSSProperties = {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#9aa3b2",
  margin: "0 0 10px",
};

const taskRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "9px 14px",
  background: "#0f121a",
  border: "1px solid #1c212c",
  borderRadius: 8,
};
