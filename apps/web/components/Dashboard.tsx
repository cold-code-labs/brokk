"use client";

import type { Task } from "@brokk/sdk";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Flame } from "lucide-react";
import { Main, Banner, Button } from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { useProject } from "../lib/project-context";
import { STATUS_COLOR, STATUS_LABEL } from "../lib/theme";

/* Tile order: live work first, then the record. Keys are API status values
 * (logic) — labels are render-only forge voice. */
const STATS = [
  { key: "running", label: "Running now" },
  { key: "queued", label: "Queued" },
  { key: "review", label: "In review · PR" },
  { key: "done", label: "Forged" },
  { key: "failed", label: "Failed" },
  { key: "all", label: "Total" },
] as const;

/* Tiles that glow accent when non-zero — live work only. */
const LIVE_TILES = new Set(["running", "review"]);

export default function Dashboard() {
  // The dashboard IS a project-scoped page — it follows the same "current
  // project" the sidebar's Anvil switcher drives, same as Board/Sindri.
  // (Previously this fetched its own project list and took index 0, so the
  // floor shown here could silently disagree with what the switcher said.)
  const { current: project, currentId, loading: projectsLoading } = useProject();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async (projectId?: string) => {
    if (!projectId) return;
    try {
      setTasks(await brokk.listTasks(projectId));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    if (!currentId) return;
    refresh(currentId);
    const interval = setInterval(() => refresh(currentId), 5_000);
    return () => clearInterval(interval);
  }, [currentId, refresh]);

  function count(key: string): number {
    if (key === "all") return tasks.length;
    return tasks.filter((t) => t.status === key).length;
  }

  // Active = running + queued combined; shown in the masthead sub line.
  const activeCount = count("running") + count("queued");
  const running = count("running");
  const recent = tasks.slice(0, 12);

  return (
    <Main className="forge-room">
      {/* ── masthead: the forge floor ── */}
      <header className="forge-head">
        <div className="forge-head-top">
          <div className="forge-head-copy">
            <span className="forge-eyebrow">Brokk · the forge floor</span>
            <h1 className="forge-title">{project ? project.name : "The floor"}</h1>
            <p className="forge-sub">
              {project
                ? `${activeCount} active · ${tasks.length} on the books`
                : projectsLoading
                  ? "Loading…"
                  : "Connect a repo to light the floor."}
            </p>
          </div>
          <div className="forge-head-actions">
            <span className={`forge-pulse${running > 0 ? "" : " is-quiet"}`}>
              <span className="forge-ember" />
              {running > 0 ? `Forging now · ${running} in the fire` : "The forge is quiet"}
            </span>
          </div>
        </div>
        <div className="forge-head-rule" />
      </header>

      {err && (
        <Banner tone="err">
          Board fetch failed: {err} — retrying every 5s.
        </Banner>
      )}

      {/* ── vitals ── */}
      <div className="forge-tiles">
        {STATS.map((s) => {
          const n = count(s.key);
          const live = LIVE_TILES.has(s.key) && n > 0;
          return (
            <div key={s.key} className={`forge-tile${live ? " is-live" : ""}`}>
              <div className="forge-tile-num">{n}</div>
              <div className="forge-tile-label">{s.label}</div>
              <span className="forge-tile-spark" />
            </div>
          );
        })}
      </div>

      {/* ── recent work ── */}
      <section>
        <div className="forge-h">
          <span className="forge-h-title">Recent work</span>
          <span className="forge-h-meta">{tasks.length}</span>
          <span className="forge-h-rule" />
        </div>
        {tasks.length === 0 ? (
          <div className="forge-empty is-panel">
            <span className="forge-empty-mark"><Flame /></span>
            <span className="forge-empty-title">The floor is clear</span>
            <p className="forge-empty-sub">Work lands here as it is queued, newest first.</p>
            <span className="forge-empty-action">
              <Button asChild>
                <Link href="/">Queue work</Link>
              </Button>
            </span>
          </div>
        ) : (
          <div className="forge-ledger">
            {recent.map((task) => (
              <div key={task.id} className={`forge-row${task.status === "running" ? " is-running" : ""}`}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: STATUS_COLOR[task.status] ?? "var(--fg-dim)",
                    flexShrink: 0,
                  }}
                />
                <span className="forge-row-title">{task.title}</span>
                {task.prUrl && (
                  <a
                    href={task.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="forge-row-mono"
                    style={{ color: "var(--accent)", flexShrink: 0 }}
                  >
                    PR ↗
                  </a>
                )}
                <span className="forge-row-meta" style={{ flexShrink: 0, color: STATUS_COLOR[task.status] ?? "var(--fg-dim)" }}>
                  {STATUS_LABEL[task.status] ?? task.status}
                </span>
              </div>
            ))}
          </div>
        )}
        {tasks.length > 12 && (
          <p className="ygg-muted" style={{ fontSize: "0.78rem", margin: "0.75rem 0 0", textAlign: "center" }}>
            {tasks.length - 12} more ·{" "}
            <Link href="/history" style={{ color: "var(--accent)", textDecoration: "none" }}>
              Open the ledger
            </Link>
          </p>
        )}
      </section>
    </Main>
  );
}
