"use client";

import type { Run, Task } from "@brokk/sdk";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ScrollText } from "lucide-react";
import { Main, Button } from "@cold-code-labs/yggdrasil-react";
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
    <Main style={{ maxWidth: "74rem" }}>
      {/* ── masthead: the ledger ── */}
      <header className="forge-head">
        <div className="forge-head-top">
          <div>
            <span className="forge-eyebrow">Brokk · the ledger</span>
            <h1 className="forge-title">History</h1>
            <p className="forge-sub">Every task the forge has touched — outcome, seat, tokens, PR. Newest first.</p>
          </div>
        </div>
        <div className="forge-head-rule" />
      </header>

      {rows.length === 0 ? (
        <div className="forge-empty is-panel">
          <span className="forge-empty-mark"><ScrollText /></span>
          <span className="forge-empty-title">Nothing in the ledger yet</span>
          <p className="forge-empty-sub">Finished work is recorded here, newest first.</p>
          <span className="forge-empty-action">
            <Button asChild>
              <Link href="/">Queue work</Link>
            </Button>
          </span>
        </div>
      ) : (
        <section>
          <div className="forge-h">
            <span className="forge-h-title">All work</span>
            <span className="forge-h-meta">{rows.length}</span>
            <span className="forge-h-rule" />
          </div>
          <div className="forge-ledger">
            <table className="ygg-table">
              <thead>
                <tr>
                  <th>Work</th>
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
                  <tr key={task.id} className={task.status === "running" ? "is-running" : undefined}>
                    <td style={{ minWidth: 0, maxWidth: "34rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {task.title}
                    </td>
                    <td>
                      <span className="ygg-badge" style={{ color: STATUS_COLOR[task.status] }}>
                        {STATUS_LABEL[task.status] ?? task.status}
                      </span>
                    </td>
                    <td className="forge-row-meta">
                      {latest ? `${latest.status}${duration(latest)}` : "—"}
                    </td>
                    <td className="ygg-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {latest?.subscriptionId ? (seatName[latest.subscriptionId] ?? "seat") : "ambient"}
                    </td>
                    <td className="num forge-row-meta">
                      {latest && (latest.tokensIn || latest.tokensOut) ? `${fmt(latest.tokensIn)}/${fmt(latest.tokensOut)}` : "—"}
                    </td>
                    <td>
                      {task.prUrl ? (
                        <a
                          href={task.prUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="forge-row-mono"
                          style={{ color: "var(--accent)", textDecoration: "none" }}
                        >
                          {prLabel(task.prUrl)} ↗
                        </a>
                      ) : "—"}
                    </td>
                    <td className="forge-row-meta">{rel(task.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Main>
  );
}

/** Render-only: pull the PR number out of the URL so the ledger reads "#42". */
function prLabel(url: string): string {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? `#${m[1]}` : "PR";
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
