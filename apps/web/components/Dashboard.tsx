"use client";

import type { Project, Task } from "@brokk/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import Link from "next/link";
import {
  Main,
  PageHeader,
  Section,
  StatStrip,
  Stat,
  Banner,
  type Tone,
} from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { STATUS_COLOR } from "../lib/theme";

const STATS = [
  { key: "all", label: "Total" },
  { key: "running", label: "Running" },
  { key: "review", label: "In Review" },
  { key: "queued", label: "Queued" },
  { key: "done", label: "Done" },
  { key: "failed", label: "Failed" },
] as const;

const TONE: Record<string, Tone | undefined> = {
  running: "info",
  review: "info",
  queued: "warn",
  done: "ok",
  failed: "err",
};

export default function Dashboard() {
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const projectIdRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async (projectId?: string) => {
    try {
      setTasks(await brokk.listTasks(projectId));
      setErr(null);
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
  }, [refresh]);

  function count(key: string): number {
    if (key === "all") return tasks.length;
    return tasks.filter((t) => t.status === key).length;
  }

  // Active = running + queued combined; shown in the project subtitle.
  const activeCount = count("running") + count("queued");

  return (
    <Main style={{ maxWidth: "68rem" }}>
      <PageHeader
        title="Dashboard"
        description={
          project ? (
            <>
              <span style={{ color: "var(--fg)" }}>{project.name}</span>
              {" · "}
              {activeCount} active
            </>
          ) : (
            <em>loading project…</em>
          )
        }
      />

      {err && <Banner tone="err">⚠ {err}</Banner>}

      <StatStrip>
        {STATS.map((s) => (
          <Stat
            key={s.key}
            value={count(s.key)}
            label={s.label}
            tone={TONE[s.key]}
            dot={s.key !== "all"}
          />
        ))}
      </StatStrip>

      <Section title="Recent tasks">
        {tasks.length === 0 ? (
          <p className="ygg-dim" style={{ fontSize: "0.85rem" }}>No tasks yet.</p>
        ) : (
          <div className="ygg-card" style={{ padding: 0, overflow: "hidden", animation: "none" }}>
            {tasks.slice(0, 12).map((task) => (
              <div key={task.id} style={taskRow}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: STATUS_COLOR[task.status] ?? "var(--fg-dim)",
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1, fontSize: "0.85rem", color: "var(--fg)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {task.title}
                </span>
                <span className="ygg-dim" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: 0.3, flexShrink: 0 }}>
                  {task.status}
                </span>
                {task.prUrl && (
                  <a href={task.prUrl} target="_blank" rel="noreferrer" style={{ fontSize: "0.7rem", color: "var(--accent)", textDecoration: "none", flexShrink: 0 }}>
                    PR ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
        {tasks.length > 12 && (
          <p className="ygg-muted" style={{ fontSize: "0.78rem", margin: "0.75rem 0 0", textAlign: "center" }}>
            +{tasks.length - 12} more —{" "}
            <Link href="/history" style={{ color: "var(--accent)", textDecoration: "none" }}>
              view all in History
            </Link>
          </p>
        )}
      </Section>
    </Main>
  );
}

const taskRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0.6rem 1rem",
  borderBottom: "1px solid var(--line-soft)",
};
