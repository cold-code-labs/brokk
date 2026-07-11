"use client";

import type { Project, Task } from "@brokk/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Flame } from "lucide-react";
import { Main, Banner, Button } from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
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

  // Active = running + queued combined; shown in the masthead sub line.
  const activeCount = count("running") + count("queued");
  const running = count("running");
  const recent = tasks.slice(0, 12);

  return (
    <Main style={{ maxWidth: "74rem" }}>
      {/* ── masthead: the forge floor ── */}
      <header className="forge-head">
        <div className="forge-head-top">
          <div>
            <span className="forge-eyebrow">Brokk · the forge floor</span>
            <h1 className="forge-title">{project ? project.name : "The floor"}</h1>
            <p className="forge-sub">
              {project ? `${activeCount} active · ${tasks.length} on the books` : "Loading…"}
            </p>
          </div>
          <span className={`forge-pulse${running > 0 ? "" : " is-quiet"}`}>
            <span className="forge-ember" />
            {running > 0 ? `Forging now · ${running} in the fire` : "The forge is quiet"}
          </span>
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
