import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeRemediation, handlePrMonitorWebhook } from "./pr-monitor.js";
import type { Store } from "@brokk/db";
import type { Task } from "@brokk/core";

describe("looksLikeRemediation", () => {
  it("skips short praise", () => {
    assert.equal(looksLikeRemediation("LGTM"), false);
    assert.equal(looksLikeRemediation("ship it"), false);
  });

  it("flags change requests", () => {
    assert.equal(looksLikeRemediation("Please fix the null deref in checkout"), true);
    assert.equal(looksLikeRemediation("CI failed on typecheck"), true);
    assert.equal(looksLikeRemediation("blocking: must rename the helper"), true);
  });
});

describe("handlePrMonitorWebhook issue_comment", () => {
  it("passes issue.body as prBody for forge-stamp matching", async () => {
    const taskId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let gotTask = false;
    let inserted = false;
    const parent = {
      id: taskId,
      projectId: "proj",
      status: "in_progress",
      title: "Ship it",
      kind: "implement",
      branch: "brokk/ship",
      prNumber: 42,
      prUrl: "https://github.com/acme/app/pull/42",
    } as unknown as Task;

    const store = {
      getTask: async (id: string) => {
        if (id === taskId) {
          gotTask = true;
          return parent;
        }
        return null;
      },
      findTaskForMergedPr: async () => null,
      findActiveTaskByDedupeKey: async () => null,
      openReviseExists: async () => false,
      listTasks: async () => [],
      insertTask: async (row: Record<string, unknown>) => {
        inserted = true;
        return { id: "revise-1", ...row };
      },
    } as unknown as Store;

    const result = await handlePrMonitorWebhook(store, "issue_comment", {
      action: "created",
      repository: { full_name: "acme/app" },
      issue: {
        number: 42,
        body: `Forged by Brokk\n\ntask \`${taskId}\`\n`,
        pull_request: { html_url: "https://github.com/acme/app/pull/42" },
      },
      comment: { id: 99, body: "Please fix the flaky assertion in checkout" },
    });

    assert.equal(gotTask, true, "should resolve parent via stamp in issue.body");
    assert.equal(inserted, true);
    assert.equal(result?.ok, true);
    if (result?.ok) assert.equal(result.action, "enqueued");
  });
});

describe("handlePrMonitorWebhook check_suite", () => {
  it("uses suite-id+pr in eventKey (not raw sha alone)", async () => {
    const keys: string[] = [];
    const parent = {
      id: "t1",
      projectId: "proj",
      status: "in_progress",
      title: "X",
      kind: "implement",
      branch: "brokk/x",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
    } as unknown as Task;

    const store = {
      getTask: async () => null,
      findTaskForMergedPr: async () => parent,
      findActiveTaskByDedupeKey: async (_p: string, key: string) => {
        keys.push(key);
        return null;
      },
      openReviseExists: async () => false,
      listTasks: async () => [],
      insertTask: async (row: { id?: string; dedupeKey?: string }) => ({
        id: "r1",
        dedupeKey: row.dedupeKey,
      }),
    } as unknown as Store;

    await handlePrMonitorWebhook(store, "check_suite", {
      action: "completed",
      repository: { full_name: "acme/app" },
      check_suite: {
        id: 555,
        conclusion: "failure",
        head_sha: "abcdef0123456789",
        head_branch: "brokk/x",
        pull_requests: [{ number: 7, html_url: "https://github.com/acme/app/pull/7" }],
      },
    });

    assert.equal(keys.length, 1);
    assert.match(keys[0]!, /suite-555-pr7-abcdef012345/);
  });
});