/**
 * PR-monitor (ADR 0074 Fase 4) — AWF-style remediation loop.
 *
 * Human review comments / CI failures on a Brokk-owned PR enqueue a `revise`
 * card (same branch), deduped so we don't stampede OpenHands.
 */

import type { Store } from "@brokk/db";
import type { Task } from "@brokk/core";
import {
  extractTaskIdFromPrBody,
  repoFullNameFromPrUrl,
} from "./pr-close.js";

const MAX_REVISIONS = Math.max(
  1,
  Number(process.env.BROKK_PR_MONITOR_MAX_REVISIONS ?? process.env.EITRI_MAX_REVISIONS ?? 3) || 3,
);

export type PrMonitorSource = "review_comment" | "review_changes" | "check_failure";

export type PrMonitorInput = {
  repoFullName: string;
  prNumber: number;
  prUrl: string;
  headRef?: string | null;
  headSha?: string | null;
  body: string;
  source: PrMonitorSource;
  /** PR body — used to find forge stamp `task \`uuid\``. */
  prBody?: string | null;
  /** Stable id for dedupe (comment id, check run id, …). */
  eventKey: string;
};

export type PrMonitorResult =
  | { ok: true; action: "enqueued"; taskId: string; dedupeKey: string }
  | { ok: true; action: "deduped"; taskId: string; dedupeKey: string }
  | { ok: true; action: "skipped"; reason: string }
  | { ok: false; error: string };

function dedupeKey(input: PrMonitorInput): string {
  const sha = (input.headSha || "nosha").slice(0, 12);
  return `pr-monitor:${input.repoFullName}:#${input.prNumber}:${input.source}:${sha}:${input.eventKey}`;
}

async function resolveParentTask(store: Store, input: PrMonitorInput): Promise<Task | null> {
  const stamped = extractTaskIdFromPrBody(input.prBody);
  if (stamped) {
    const t = await store.getTask(stamped);
    if (t) return t;
  }
  return store.findTaskForMergedPr(input.prUrl, input.prNumber, input.repoFullName);
}

/** True when the text looks like a request for changes (not pure praise). */
export function looksLikeRemediation(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  if (/\b(lgtm|ship it|looks good|approved|nice work)\b/.test(t) && t.length < 80) {
    return false;
  }
  return (
    /\b(please|fix|bug|broken|fail|must|should|nit|blocking|request changes|ci failed|needs?)\b/i.test(
      t,
    ) || t.length > 40
  );
}

export async function enqueuePrRemediation(
  store: Store,
  input: PrMonitorInput,
): Promise<PrMonitorResult> {
  if (!input.repoFullName || !input.prNumber) {
    return { ok: true, action: "skipped", reason: "missing repo/pr" };
  }
  if (input.source === "review_comment" && !looksLikeRemediation(input.body)) {
    return { ok: true, action: "skipped", reason: "not remediation-shaped" };
  }

  const parent = await resolveParentTask(store, input);
  if (!parent) {
    return { ok: true, action: "skipped", reason: "no brokk task for pr" };
  }
  if (parent.status === "done" || parent.status === "cancelled") {
    return { ok: true, action: "skipped", reason: `parent ${parent.status}` };
  }

  const key = dedupeKey(input);
  const existing = await store.findActiveTaskByDedupeKey(parent.projectId, key);
  if (existing) {
    return { ok: true, action: "deduped", taskId: existing.id, dedupeKey: key };
  }

  if (await store.openReviseExists(input.prNumber)) {
    return { ok: true, action: "skipped", reason: "revise already in flight" };
  }

  const rounds = (await store.listTasks({ projectId: parent.projectId })).filter(
    (t) => t.kind === "revise" && t.prNumber === input.prNumber,
  ).length;
  if (rounds >= MAX_REVISIONS) {
    return { ok: true, action: "skipped", reason: `hit ${MAX_REVISIONS}-round cap` };
  }

  const branch = input.headRef || parent.branch;
  if (!branch) {
    return { ok: true, action: "skipped", reason: "no branch" };
  }

  const title =
    input.source === "check_failure"
      ? `CI heal PR #${input.prNumber}: ${parent.title}`
      : `Revise PR #${input.prNumber}: ${parent.title}`;

  const body = [
    input.source === "check_failure"
      ? `Address this CI failure on PR #${input.prNumber} and push fixes to the same branch.`
      : `Address this review feedback on PR #${input.prNumber} and push fixes to the same branch.`,
    "Do not open a new PR.",
    "",
    `Source: ${input.source}`,
    input.headSha ? `Head: ${input.headSha}` : "",
    "",
    input.body.slice(0, 6000),
  ]
    .filter(Boolean)
    .join("\n");

  const task = await store.insertTask({
    projectId: parent.projectId,
    kind: "revise",
    status: "queued",
    title: title.slice(0, 200),
    body,
    prNumber: input.prNumber,
    branch,
    prUrl: input.prUrl || parent.prUrl,
    iteration: rounds + 1,
    createdBy: "pr-monitor",
    dedupeKey: key,
    labels: [`pr-monitor:${input.source}`],
  });

  return { ok: true, action: "enqueued", taskId: task.id, dedupeKey: key };
}

/** Map a GitHub webhook payload into a remediation enqueue (or skip). */
export async function handlePrMonitorWebhook(
  store: Store,
  event: string,
  payload: Record<string, unknown>,
): Promise<PrMonitorResult | null> {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name;
  if (!repo) return null;

  if (event === "pull_request_review" && payload.action === "submitted") {
    const review = payload.review as {
      state?: string;
      body?: string;
      id?: number;
    };
    const pr = payload.pull_request as {
      number?: number;
      html_url?: string;
      body?: string | null;
      head?: { ref?: string; sha?: string };
    };
    if (!pr?.number || !pr.html_url) return null;
    const state = (review?.state || "").toUpperCase();
    if (state !== "CHANGES_REQUESTED" && state !== "COMMENTED") return null;
    const body = (review?.body || "").trim();
    if (state === "COMMENTED" && !looksLikeRemediation(body)) {
      return { ok: true, action: "skipped", reason: "comment not remediation" };
    }
    return enqueuePrRemediation(store, {
      repoFullName: repo,
      prNumber: pr.number,
      prUrl: pr.html_url,
      prBody: pr.body,
      headRef: pr.head?.ref,
      headSha: pr.head?.sha,
      body: body || `Review state: ${state}`,
      source: state === "CHANGES_REQUESTED" ? "review_changes" : "review_comment",
      eventKey: String(review?.id ?? `${state}-${pr.head?.sha ?? pr.number}`),
    });
  }

  if (event === "pull_request_review_comment" && (payload.action === "created" || !payload.action)) {
    const comment = payload.comment as { body?: string; id?: number };
    const pr = payload.pull_request as {
      number?: number;
      html_url?: string;
      body?: string | null;
      head?: { ref?: string; sha?: string };
    };
    if (!pr?.number || !pr.html_url || !comment?.body) return null;
    return enqueuePrRemediation(store, {
      repoFullName: repo,
      prNumber: pr.number,
      prUrl: pr.html_url,
      prBody: pr.body,
      headRef: pr.head?.ref,
      headSha: pr.head?.sha,
      body: comment.body,
      source: "review_comment",
      eventKey: String(comment.id ?? Date.now()),
    });
  }

  if (event === "issue_comment" && payload.action === "created") {
    const issue = payload.issue as { pull_request?: { html_url?: string }; number?: number };
    if (!issue?.pull_request?.html_url) return null;
    const comment = payload.comment as { body?: string; id?: number };
    const prUrl = issue.pull_request.html_url;
    const prNumber = issue.number;
    if (!prNumber || !comment?.body) return null;
    return enqueuePrRemediation(store, {
      repoFullName: repoFullNameFromPrUrl(prUrl) || repo,
      prNumber,
      prUrl,
      body: comment.body,
      source: "review_comment",
      eventKey: String(comment.id ?? Date.now()),
    });
  }

  if (event === "check_suite" && payload.action === "completed") {
    const suite = payload.check_suite as {
      conclusion?: string;
      head_sha?: string;
      head_branch?: string;
      pull_requests?: { number: number; url?: string }[];
    };
    if (suite?.conclusion !== "failure" && suite?.conclusion !== "timed_out") return null;
    const prs = suite.pull_requests ?? [];
    if (!prs.length) return null;
    const pr = prs[0]!;
    const prUrl =
      (pr as { html_url?: string }).html_url ||
      `https://github.com/${repo}/pull/${pr.number}`;
    return enqueuePrRemediation(store, {
      repoFullName: repo,
      prNumber: pr.number,
      prUrl,
      headRef: suite.head_branch,
      headSha: suite.head_sha,
      body: `check_suite ${suite.conclusion} on ${suite.head_sha ?? "unknown"}`,
      source: "check_failure",
      eventKey: suite.head_sha || String(pr.number),
    });
  }

  if (event === "check_run" && payload.action === "completed") {
    const run = payload.check_run as {
      conclusion?: string;
      id?: number;
      name?: string;
      head_sha?: string;
      html_url?: string;
      check_suite?: { head_branch?: string };
      pull_requests?: { number: number; html_url?: string }[];
    };
    if (run?.conclusion !== "failure" && run?.conclusion !== "timed_out") return null;
    const prs = run.pull_requests ?? [];
    if (!prs.length) return null;
    const pr = prs[0]!;
    const prUrl = pr.html_url || `https://github.com/${repo}/pull/${pr.number}`;
    return enqueuePrRemediation(store, {
      repoFullName: repo,
      prNumber: pr.number,
      prUrl,
      headRef: run.check_suite?.head_branch,
      headSha: run.head_sha,
      body: `check_run "${run.name ?? "ci"}" ${run.conclusion}${run.html_url ? `\n${run.html_url}` : ""}`,
      source: "check_failure",
      eventKey: String(run.id ?? run.head_sha ?? pr.number),
    });
  }

  return null;
}
