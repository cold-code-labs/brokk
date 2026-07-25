/**
 * Zombie-run detection for the Board drill-in: a run whose status is still
 * `running` while the runner's heartbeats stopped is a zombie — SSE looks
 * "live" but nothing will ever produce events again. Pure so the rule is
 * unit-testable with node:test (same pattern as run-log.ts).
 */

/** Runner heartbeats every 15s (apps/forge); 6 missed beats = the runner is
 *  gone (redeploy/OOM/SIGKILL), not just a slow tick. */
export const RUNNER_STALE_MS_DEFAULT = 90_000;

/** True when a `running` run's runner has stopped heartbeating: last-seen (or,
 *  for a runner row that never registered / was deleted, the run's own start)
 *  is older than `staleMs`. Non-running runs are never stale; a running run
 *  with no anchor at all can't be judged → not stale. */
export function isRunStale(
  run: { status: string; startedAt: string | null },
  runnerLastSeenAt: string | null,
  opts: { now?: number; staleMs?: number } = {},
): boolean {
  if (run.status !== "running") return false;
  const anchor = runnerLastSeenAt ?? run.startedAt;
  if (!anchor) return false;
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? RUNNER_STALE_MS_DEFAULT;
  return now - new Date(anchor).getTime() > staleMs;
}
