/**
 * Review reconciler (BROKK-45) — heal cards stuck in `review` when the GitHub
 * merge webhook was missed or the card still points at a closed-without-merge PR.
 *
 * Every tick (and once at boot):
 *   1. List tasks/plans in `review` with a stored PR.
 *   2. Ask GitHub if that PR is merged → applyMergedPr.
 *   3. If the stored PR is closed≠merged, search for a newer merged PR whose body
 *      stamps this task/plan id (the #5→#6 re-forge case) and close on that.
 *
 * Uses `gh api` like conversations.ts — needs GITHUB_TOKEN (already on brokk-api).
 * Without a token the reconciler no-ops (webhook path still works).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Plan, Task } from "@brokk/core";
import type { Store } from "@brokk/db";
import { applyMergedPr } from "./apply-merged-pr.js";
import { prNumberFromUrl, repoFullNameFromPrUrl } from "./pr-close.js";

const run = promisify(execFile);
const GH_BIN = process.env.BROKK_GH_BIN ?? "gh";
const GH_OPTS = { maxBuffer: 8 * 1024 * 1024, timeout: 25_000, killSignal: "SIGKILL" as const };

export interface ReviewReconcilerDeps {
  store: Store;
  /** PAT / installation token for `gh`. Empty = reconciler disabled. */
  githubToken: string;
}

type GhPr = {
  number: number;
  html_url: string;
  merged: boolean;
  state: string;
  body: string | null;
};

/** Start the singleton reconciler. Overlapping ticks are skipped. Returns stop fn. */
export function startReviewReconciler(
  deps: ReviewReconcilerDeps,
  intervalMs = 60_000,
): () => void {
  if (!deps.githubToken) {
    console.warn(
      "[review-reconciler] GITHUB_TOKEN unset — poll/backfill disabled (webhook-only)",
    );
    return () => {};
  }

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const closed = await reconcileReviewBoard(deps);
      if (closed > 0) {
        console.log(`[review-reconciler] closed ${closed} card(s)/plan(s) stuck in review`);
      }
    } catch (err) {
      console.error("[review-reconciler] tick failed:", err);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick(); // boot backfill
  console.log(
    `[review-reconciler] started (every ${Math.round(intervalMs / 1000)}s) — heals missed merge webhooks`,
  );
  return () => clearInterval(timer);
}

/** One pass over review tasks + plans. Exported for tests / manual triggers. */
export async function reconcileReviewBoard(deps: ReviewReconcilerDeps): Promise<number> {
  let closed = 0;
  const reviewTasks = await deps.store.listTasks({ status: "review" });
  for (const task of reviewTasks) {
    try {
      if (await reconcileOneTask(deps, task)) closed++;
    } catch (err) {
      console.error(
        `[review-reconciler] task ${task.id.slice(0, 8)} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const plans = (await deps.store.listPlans()).filter((p) => p.status === "review");
  for (const plan of plans) {
    try {
      if (await reconcileOnePlan(deps, plan)) closed++;
    } catch (err) {
      console.error(
        `[review-reconciler] plan ${plan.id.slice(0, 8)} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return closed;
}

async function reconcileOneTask(deps: ReviewReconcilerDeps, task: Task): Promise<boolean> {
  const repo = await repoForProject(deps.store, task.projectId);
  if (!repo) return false;

  const stored = await resolveStoredPr(deps, repo, task.prUrl, task.prNumber);
  if (stored?.merged) {
    const r = await applyMergedPr(deps.store, stored, {
      repoFullName: repo,
      actor: "review-reconciler",
    });
    return r.kind !== "none";
  }
  // Still open → wait for merge (webhook or a later tick). Only hunt a successor
  // when the stored PR is gone/closed-without-merge (the #5→#6 case).
  if (stored && stored.state === "open") return false;

  const successor = await findMergedPrByStamp(deps, repo, "task", task.id);
  if (!successor) return false;
  const r = await applyMergedPr(deps.store, successor, {
    repoFullName: repo,
    actor: "review-reconciler",
  });
  return r.kind !== "none";
}

async function reconcileOnePlan(deps: ReviewReconcilerDeps, plan: Plan): Promise<boolean> {
  const repo = await repoForProject(deps.store, plan.projectId);
  if (!repo) return false;

  const stored = await resolveStoredPr(deps, repo, plan.prUrl, plan.prNumber);
  if (stored?.merged) {
    const r = await applyMergedPr(deps.store, stored, {
      repoFullName: repo,
      actor: "review-reconciler",
    });
    return r.kind !== "none";
  }
  if (stored && stored.state === "open") return false;

  const successor = await findMergedPrByStamp(deps, repo, "plan", plan.id);
  if (!successor) return false;
  const r = await applyMergedPr(deps.store, successor, {
    repoFullName: repo,
    actor: "review-reconciler",
  });
  return r.kind !== "none";
}

async function repoForProject(store: Store, projectId: string): Promise<string | null> {
  const project = await store.getProject(projectId);
  if (!project) return null;
  const repo = await store.getRepository(project.repositoryId);
  return repo?.fullName ?? null;
}

async function resolveStoredPr(
  deps: ReviewReconcilerDeps,
  repo: string,
  prUrl: string | null,
  prNumber: number | null,
): Promise<GhPr | null> {
  const n = prNumber ?? (prUrl ? prNumberFromUrl(prUrl) : null);
  if (n == null) return null;
  const fromUrl = prUrl ? repoFullNameFromPrUrl(prUrl) : null;
  const fullRepo = fromUrl ?? repo;
  return fetchPr(deps.githubToken, fullRepo, n);
}

async function fetchPr(token: string, repo: string, number: number): Promise<GhPr | null> {
  try {
    const { stdout } = await run(
      GH_BIN,
      [
        "api",
        `repos/${repo}/pulls/${number}`,
        "--jq",
        "{number,html_url,merged,state,body}",
      ],
      { ...GH_OPTS, env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } },
    );
    const pr = JSON.parse(stdout) as GhPr;
    // `gh --jq` may leave merged as bool; normalize.
    return {
      number: pr.number,
      html_url: pr.html_url,
      merged: Boolean(pr.merged),
      state: pr.state,
      body: pr.body ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Search merged PRs whose body contains the forge stamp `task \`uuid\`` /
 * `plan \`uuid\``. Prefer `gh pr list` over search/issues — stamps with backticks
 * are unreliable in GitHub's search index.
 */
async function findMergedPrByStamp(
  deps: ReviewReconcilerDeps,
  repo: string,
  kind: "task" | "plan",
  id: string,
): Promise<GhPr | null> {
  const needle = `${kind} \`${id}\``;
  try {
    const { stdout } = await run(
      GH_BIN,
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "merged",
        "--limit",
        "50",
        "--json",
        "number,url,body",
      ],
      {
        ...GH_OPTS,
        env: { ...process.env, GH_TOKEN: deps.githubToken, GITHUB_TOKEN: deps.githubToken },
      },
    );
    const prs = JSON.parse(stdout || "[]") as Array<{
      number: number;
      url: string;
      body: string | null;
    }>;
    const hit = prs.find((p) => (p.body ?? "").includes(needle));
    if (!hit) return null;
    return {
      number: hit.number,
      html_url: hit.url,
      merged: true,
      state: "closed",
      body: hit.body,
    };
  } catch {
    return null;
  }
}
