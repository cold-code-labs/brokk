"use client";

/**
 * BROKK-39 acceptance fixture — renders the forge-floor drill-in + RunLog
 * (thinking/tools) without a live API/run. Brokk's acceptance.mjs drives this
 * route under BROKK_OPEN_SHELL (/brokk/observer).
 */
import { useRef, useState } from "react";
import type { RunEvent } from "@brokk/sdk";
import { Main, Button } from "@cold-code-labs/yggdrasil-react";
import { RunLog, RunnerLostBanner } from "../../../../components/Board";
import { STATUS_COLOR } from "../../../../lib/theme";

const FIXTURE_EVENTS: RunEvent[] = [
  {
    id: "e1",
    runId: "r1",
    seq: 1,
    at: new Date().toISOString(),
    type: "thinking",
    payload: { text: "I should open the floor row and watch the forge think." },
  },
  {
    id: "e2",
    runId: "r1",
    seq: 2,
    at: new Date().toISOString(),
    type: "message",
    payload: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Wire the observer to the Live run log." },
        { type: "text", text: "Opening the task drawer to stream tools." },
        { type: "tool_use", id: "t1", name: "bash", input: { command: "ls apps/web" } },
      ],
    },
  },
  {
    id: "e3",
    runId: "r1",
    seq: 3,
    at: new Date().toISOString(),
    type: "tool_result",
    payload: { tool_use_id: "t1", ok: true, preview: "Board.tsx\nDashboard.tsx" },
  },
];

/** Zombie fixture: run still `running` but the runner's heartbeats stopped
 *  10 minutes ago — the drawer must show the sticky "runner lost" banner
 *  instead of a healthy live strip. */
const STALE_LAST_SEEN = new Date(Date.now() - 10 * 60_000).toISOString();

export default function ObserverFixturePage() {
  const [open, setOpen] = useState<false | "live" | "stale">(false);
  const logRef = useRef<HTMLDivElement>(null);

  return (
    <Main className="forge-room">
      <header className="forge-head">
        <div className="forge-head-copy">
          <span className="forge-eyebrow">Brokk · observer fixture</span>
          <h1 className="forge-title">Floor drill-in</h1>
          <p className="forge-sub">Click the running row — Live run log with thinking + tools.</p>
        </div>
      </header>

      <div className="forge-ledger">
        <button
          type="button"
          data-testid="forge-floor-row"
          className="forge-row is-clickable is-running"
          onClick={() => setOpen("live")}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: STATUS_COLOR.running,
              flexShrink: 0,
            }}
          />
          <span className="forge-row-title">BROKK-39 · watch the forge think</span>
          <span className="forge-row-meta" style={{ color: STATUS_COLOR.running }}>
            Running
          </span>
        </button>
        <button
          type="button"
          data-testid="forge-floor-row-stale"
          className="forge-row is-clickable is-running"
          onClick={() => setOpen("stale")}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: STATUS_COLOR.failed,
              flexShrink: 0,
            }}
          />
          <span className="forge-row-title">Zombie · runner heartbeats stopped</span>
          <span className="forge-row-meta" style={{ color: STATUS_COLOR.failed }}>
            Running (stale)
          </span>
        </button>
      </div>

      {open && (
        <div
          data-testid="observer-drawer"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            zIndex: 40,
            display: "flex",
            justifyContent: "flex-end",
          }}
          onClick={() => setOpen(false)}
        >
          <aside
            style={{
              width: "min(420px, 100%)",
              height: "100%",
              background: "var(--panel)",
              borderLeft: "1px solid var(--line)",
              padding: 20,
              overflow: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>
                {open === "stale" ? "Zombie · runner heartbeats stopped" : "BROKK-39 · watch the forge think"}
              </h2>
              <Button variant="outline" size="icon" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </Button>
            </div>
            {open === "stale" && <RunnerLostBanner lastSeenAt={STALE_LAST_SEEN} />}
            <h3 className="ygg-muted" style={{ fontSize: 12, textTransform: "uppercase", margin: "16px 0 8px" }}>
              {open === "stale" ? "Run log (stalled)" : "Live run log"}
            </h3>
            <RunLog events={FIXTURE_EVENTS} logRef={logRef} />
          </aside>
        </div>
      )}
    </Main>
  );
}
