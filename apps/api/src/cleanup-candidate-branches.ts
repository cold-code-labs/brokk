/**
 * Delete a card's superseded candidate branches after it reaches a terminal
 * state (branch hygiene). The winning branch is already removed by
 * `gh pr merge --delete-branch`; this prunes the *losing* per-attempt branches
 * (`brokk/<slug>-<runId8>`) that otherwise leak onto the remote forever.
 *
 * Best-effort and idempotent: never throws, ignores 404/422 (already gone or
 * protected), and skips any branch that still backs an open PR. Only ever
 * touches `brokk/`-prefixed branches — never dev/main/base.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Store } from "@brokk/db";

const run = promisify(execFile);
const GH_BIN = process.env.BROKK_GH_BIN ?? "gh";

export async function cleanupCandidateBranches(
  store: Store,
  opts: { repo: string | null; taskId: string; githubToken?: string | null },
): Promise<void> {
  const repo = opts.repo;
  const token =
    opts.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
  if (!repo || !token) return; // no repo or no creds → nothing safe to do

  try {
    const task = await store.getTask(opts.taskId);
    if (!task) return;
    // Plan cards share ONE feature branch — never prune on an individual card;
    // that branch is cleaned when the plan PR merges (--delete-branch).
    if (task.planId) return;

    const runs = await store.listRunsByTask(opts.taskId);
    const winner = task.branch ?? null; // PR head — already deleted by GitHub
    const candidates = [
      ...new Set(
        runs
          .map((r) => r.branch)
          .filter((b): b is string => !!b && b.startsWith("brokk/")),
      ),
    ].filter((b) => b !== winner);
    if (candidates.length === 0) return;

    const env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
    for (const branch of candidates) {
      try {
        // Do not nuke a branch that still backs an open PR.
        const { stdout } = await run(
          GH_BIN,
          [
            "pr", "list", "-R", repo, "--head", branch,
            "--state", "open", "--json", "number", "--jq", "length",
          ],
          { env },
        );
        if (stdout.trim() !== "0") continue;
        await run(
          GH_BIN,
          ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`],
          { env },
        );
        console.log(`[branch-cleanup] deleted ${repo} ${branch}`);
      } catch {
        // 404 (already gone) / 422 (protected) / transient — best-effort.
      }
    }
  } catch (err) {
    console.warn(`[branch-cleanup] skipped for task ${opts.taskId}:`, err);
  }
}
