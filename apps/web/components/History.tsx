"use client";

import type { Run, Task } from "@brokk/sdk";
import { useEffect, useState } from "react";
import { Main, PageHeader, EmptyState } from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { STATUS_COLOR, STATUS_LABEL } from "../lib/theme";

type Row = { task: Task; latest?: Run };

export default function History() {
  const [rows, setRows] = useState<Row[]>([]);
  const [seatName, setSeatName] = useState<Record<string, string>>({});
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    let alive = true;
    const load = async () => {
      try {
        const [tasks, subs, users] = await Promise.all([
          brokk.listTasks(),
          brokk.listSubscriptions().catch(() => []),
          brokk.listUsers().catch(() => []),
        ]);
        const userById = Object.fromEntries(users.map((u) => [u.id, u.name]));
        const map: Record<string, string> = {};
        for (const s of subs) map[s.id] = userById[s.userId] ?? s.label;
        const withRuns = await Promise.all(
          tasks.map(async (task) => ({ task, latest: (await brokk.listTaskRuns(task.id).catch(() => []))[0] })),
        );
        if (alive) {
          withRuns.sort((a, b) => (a.task.updatedAt < b.task.updatedAt ? 1 : -1));
          setRows(withRuns);
          setSeatName(map);
        }
      } catch {
        /* ignore */
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (!mounted) return null;

  return (
    <Main style={{ maxWidth: "69rem" }}>
      <PageHeader
        title="History"
        description="Every task the forge has touched — status, run outcome, and the PR."
      />

      {rows.length === 0 ? (
        <EmptyState title="No tasks yet" description="Once the forge starts working, every task lands here." />
      ) : (
        <div className="ygg-card" style={{ padding: 0, overflow: "hidden", animation: "none" }}>
          <table className="ygg-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>Run</th>
                <th>Seat</th>
                <th className="num">Tokens</th>
                <th>PR</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ task, latest }) => (
                <tr key={task.id}>
                  <td style={{ minWidth: 0, maxWidth: "20rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {task.title}
                  </td>
                  <td>
                    <span className="ygg-badge" style={{ color: STATUS_COLOR[task.status] }}>
                      {STATUS_LABEL[task.status] ?? task.status}
                    </span>
                  </td>
                  <td className="ygg-muted">
                    {latest ? `${latest.status}${duration(latest)}` : "—"}
                  </td>
                  <td className="ygg-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {latest?.subscriptionId ? (seatName[latest.subscriptionId] ?? "seat") : "ambient"}
                  </td>
                  <td className="num ygg-muted">
                    {latest && (latest.tokensIn || latest.tokensOut) ? `${fmt(latest.tokensIn)}/${fmt(latest.tokensOut)}` : "—"}
                  </td>
                  <td>
                    {task.prUrl ? (
                      <a href={task.prUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", textDecoration: "none" }}>
                        PR ↗
                      </a>
                    ) : "—"}
                  </td>
                  <td className="ygg-dim">{rel(task.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Main>
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
