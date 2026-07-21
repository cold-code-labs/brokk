import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMergedPr } from "./apply-merged-pr.js";

/** Minimal store stub — only the methods applyMergedPr touches. */
function fakeStore(seed: {
  task?: {
    id: string;
    status: string;
    prUrl: string | null;
    prNumber: number | null;
  };
  plan?: { id: string; status: string };
}) {
  const calls: string[] = [];
  return {
    calls,
    async getPlan(id: string) {
      return seed.plan?.id === id ? { ...seed.plan } : null;
    },
    async getTask(id: string) {
      return seed.task?.id === id ? { ...seed.task } : null;
    },
    async findPlanForMergedPr() {
      return seed.plan && !seed.task ? { ...seed.plan } : null;
    },
    async findTaskForMergedPr() {
      return seed.task ? { ...seed.task } : null;
    },
    async markPlanDone(id: string) {
      calls.push(`markPlanDone:${id}`);
      return { id, status: "done" };
    },
    async transitionTask(id: string, to: string) {
      calls.push(`transitionTask:${id}:${to}`);
      return { id, status: to };
    },
    async updateTask(id: string) {
      calls.push(`updateTask:${id}`);
      return { id };
    },
  };
}

test("applyMergedPr ignores closed-without-merge", async () => {
  const store = fakeStore({});
  const r = await applyMergedPr(store as never, {
    html_url: "https://github.com/a/b/pull/1",
    number: 1,
    merged: false,
  });
  assert.equal(r.kind, "none");
  assert.equal(r.status, "ignored");
  assert.equal(store.calls.length, 0);
});

test("applyMergedPr closes task via forge body stamp (#5→#6)", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const store = fakeStore({
    task: {
      id,
      status: "review",
      prUrl: "https://github.com/a/b/pull/5",
      prNumber: 5,
    },
  });
  const r = await applyMergedPr(
    store as never,
    {
      html_url: "https://github.com/a/b/pull/6",
      number: 6,
      merged: true,
      body: `🔨 Forged by **Brokk** · task \`${id}\``,
    },
    { repoFullName: "a/b" },
  );
  assert.equal(r.kind, "task");
  assert.equal(r.id, id);
  assert.ok(store.calls.some((c) => c.startsWith(`transitionTask:${id}:done`)));
});

test("applyMergedPr falls back to findTaskForMergedPr", async () => {
  const store = fakeStore({
    task: {
      id: "t1",
      status: "review",
      prUrl: "https://github.com/a/b/pull/3",
      prNumber: 3,
    },
  });
  const r = await applyMergedPr(store as never, {
    html_url: "https://github.com/a/b/pull/3",
    number: 3,
    merged: true,
    body: "no stamp",
  });
  assert.equal(r.kind, "task");
  assert.equal(r.id, "t1");
});
