/**
 * BROKK-22 (forge lane): the reconciler tick must sweep stale forge runs next
 * to the existing driver-run reap — the wiring is what turns the db helper
 * into an actual backstop. Uses a fake Store (no live Postgres in CI); the
 * SQL itself is exercised in staging per the card's acceptance.
 * Run: `pnpm --filter @brokk/api test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Store } from "@brokk/db";
import { startMissionReconciler } from "./missions.js";

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

test("reconciler tick calls reapStaleRuns with a sane TTL + requeue cap", async () => {
  const calls: { staleMs: number; maxRequeues?: number }[] = [];
  const store = {
    reapStaleDriverRuns: async () => 0,
    reapStaleRuns: async (staleMs: number, opts?: { maxRequeues?: number }) => {
      calls.push({ staleMs, maxRequeues: opts?.maxRequeues });
      return 1;
    },
    listMissions: async () => [],
    listTasks: async () => [],
  } as unknown as Store;

  const stop = startMissionReconciler({ store }, 60 * 60 * 1000);
  await settle();
  stop();

  assert.equal(calls.length, 1, "one sweep per tick");
  // Default TTL: above lease/heartbeat cadence, below an hour (the reconciler
  // must reap well before an operator would notice the stuck card by hand).
  assert.ok(calls[0]!.staleMs >= 60_000, `staleMs ${calls[0]!.staleMs} too aggressive`);
  assert.ok(calls[0]!.staleMs <= 60 * 60 * 1000, `staleMs ${calls[0]!.staleMs} too lax`);
  assert.equal(typeof calls[0]!.maxRequeues, "number");
  assert.ok(calls[0]!.maxRequeues! >= 0);
});

test("a reapStaleRuns crash never kills the tick", async () => {
  let missionsListed = 0;
  const store = {
    reapStaleDriverRuns: async () => 0,
    reapStaleRuns: async () => {
      throw new Error("db hiccup");
    },
    listMissions: async () => {
      missionsListed++;
      return [];
    },
    listTasks: async () => [],
  } as unknown as Store;

  const stop = startMissionReconciler({ store }, 60 * 60 * 1000);
  await settle();
  stop();

  assert.ok(missionsListed > 0, "tick continued past the reap failure");
});
