/**
 * Apply a merged GitHub PR to the board (BROKK-45).
 *
 * Shared by the webhook (push) and the review reconciler (poll/backfill) so both
 * paths use the same matching order: forge stamp in body → plan → task by URL/#.
 */
import type { Store } from "@brokk/db";
import {
  extractPlanIdFromPrBody,
  extractTaskIdFromPrBody,
  repoFullNameFromPrUrl,
  shouldMarkDoneOnPrClose,
} from "./pr-close.js";

export type MergedPrInput = {
  html_url: string;
  number: number;
  merged?: boolean | null;
  body?: string | null;
};

export type CloseResult =
  | { ok: true; kind: "plan" | "task"; id: string; status: "done" | string }
  | { ok: true; kind: "none"; id: null; status: "not_found" | "ignored" | string };

export async function applyMergedPr(
  store: Store,
  pr: MergedPrInput,
  opts?: { repoFullName?: string | null; actor?: string },
): Promise<CloseResult> {
  if (!shouldMarkDoneOnPrClose(pr) || !pr.html_url || !pr.number) {
    return { ok: true, kind: "none", id: null, status: "ignored" };
  }

  const actor = opts?.actor ?? "github";
  const repo =
    opts?.repoFullName ?? repoFullNameFromPrUrl(pr.html_url) ?? null;
  const reason = `PR merged (#${pr.number})`;
  const extra = { prUrl: pr.html_url, prNumber: pr.number };

  // 1) Forge stamp in the PR body — survives #5→#6 when the card still points at
  //    the closed-without-merge PR.
  const planId = extractPlanIdFromPrBody(pr.body);
  if (planId) {
    const plan = await store.getPlan(planId);
    if (plan) {
      if (plan.status !== "done") {
        await store.markPlanDone(plan.id, pr.html_url, pr.number);
      }
      return { ok: true, kind: "plan", id: plan.id, status: "done" };
    }
  }
  const taskId = extractTaskIdFromPrBody(pr.body);
  if (taskId) {
    const task = await store.getTask(taskId);
    if (task) {
      if (task.status !== "done") {
        await store.transitionTask(task.id, "done", { actor, reason, extra });
      } else if (task.prNumber !== pr.number || task.prUrl !== pr.html_url) {
        // Already done (e.g. via an earlier path) but pointer is stale — refresh.
        await store.updateTask(task.id, extra);
      }
      return { ok: true, kind: "task", id: task.id, status: "done" };
    }
  }

  // 2) Shared feature PR on a plan.
  const plan = await store.findPlanForMergedPr(pr.html_url, pr.number, repo);
  if (plan) {
    if (plan.status !== "done") {
      await store.markPlanDone(plan.id, pr.html_url, pr.number);
    }
    return { ok: true, kind: "plan", id: plan.id, status: "done" };
  }

  // 3) Standalone card by URL / repo-scoped number.
  const task = await store.findTaskForMergedPr(pr.html_url, pr.number, repo);
  if (task) {
    if (task.status !== "done") {
      await store.transitionTask(task.id, "done", { actor, reason, extra });
    } else if (task.prNumber !== pr.number || task.prUrl !== pr.html_url) {
      await store.updateTask(task.id, extra);
    }
    return { ok: true, kind: "task", id: task.id, status: "done" };
  }

  return { ok: true, kind: "none", id: null, status: "not_found" };
}
