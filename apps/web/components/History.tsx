"use client";

import type { Run, Task } from "@brokk/sdk";
import { useEffect, useState } from "react";
import { brokk } from "../lib/api";

const STATUS_COLOR: Record<string, string> = {
  backlog: "#5c6575", queued: "#b08900", running: "#2f81f7", review: "#a371f7",
  done: "#2ea043", failed: "#f85149", cancelled: "#5c6575", succeeded: "#2ea043",
};

type Row = { task: Task; latest?: Run };

export default function History() {
  const [rows, setRows] = useState<Row[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    let alive = true;
    const load = async () => {
      try {
        const tasks = await brokk.listTasks();
        const withRuns = await Promise.all(
          tasks.map(async (task) => ({ task, latest: (await brokk.listTaskRuns(task.id).catch(() => []))[0] })),
        );
        if (alive) {
          withRuns.sort((a, b) => (a.task.updatedAt < b.task.updatedAt ? 1 : -1));
          setRows(withRuns);
        }
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!mounted) return null;

  return (
    <div style={{ padding: "28px 32px", maxWidth: 1100 }}>
      <h1 style={{ margin: 0, fontSize: 22, letterSpacing: -0.4 }}>History</h1>
      <p style={{ margin: "4px 0 20px", color: "#9aa3b2", fontSize: 14 }}>
        Every task the forge has touched — status, run outcome, and the PR.
      </p>

      <div style={table}>
        <div style={{ ...trow, color: "#5c6575", fontSize: 11, textTransform: "uppercase", borderBottom: "1px solid #1c212c" }}>
          <span>Task</span><span>Status</span><span>Run</span><span>Tokens</span><span>PR</span><span>Updated</span>
        </div>
        {rows.length === 0 && <p style={{ padding: 16, color: "#3f4654", fontSize: 13 }}>No tasks yet.</p>}
        {rows.map(({ task, latest }) => (
          <div key={task.id} style={trow}>
            <span style={{ fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</span>
            <span><Badge text={task.status} color={STATUS_COLOR[task.status]} /></span>
            <span style={{ fontSize: 12, color: "#9aa3b2" }}>
              {latest ? `${latest.status}${duration(latest)}` : "—"}
            </span>
            <span style={{ fontSize: 12, color: "#9aa3b2" }}>
              {latest && (latest.tokensIn || latest.tokensOut) ? `${fmt(latest.tokensIn)}/${fmt(latest.tokensOut)}` : "—"}
            </span>
            <span>
              {task.prUrl ? (
                <a href={task.prUrl} target="_blank" rel="noreferrer" style={{ color: "#a371f7", fontSize: 12, textDecoration: "none" }}>
                  PR ↗
                </a>
              ) : "—"}
            </span>
            <span style={{ fontSize: 12, color: "#5c6575" }}>{rel(task.updatedAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Badge({ text, color }: { text: string; color?: string }) {
  return (
    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: "#141823", color: color ?? "#9aa3b2", border: `1px solid ${color ?? "#2a2f3a"}33` }}>
      {text}
    </span>
  );
}

function duration(r: Run): string {
  if (!r.startedAt || !r.endedAt) return "";
  const ms = new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime();
  return ms > 0 ? ` · ${Math.round(ms / 1000)}s` : "";
}
function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0);
}
function rel(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const table: React.CSSProperties = { border: "1px solid #1c212c", borderRadius: 10, overflow: "hidden", background: "#0f121a" };
const trow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0,2.4fr) 0.9fr 1.2fr 0.8fr 0.5fr 0.9fr",
  gap: 10,
  alignItems: "center",
  padding: "11px 16px",
  borderBottom: "1px solid #12151c",
};
