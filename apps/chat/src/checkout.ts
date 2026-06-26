// ─────────────────────────────────────────────────────────────────────────────
// Per-session working checkouts. Each chat session owns ONE long-lived git
// worktree on its own branch (`sindri/<id8>`), forked from the project's base
// branch. Unlike the forge's throwaway worktrees, a session checkout PERSISTS
// across turns — uncommitted edits carry over, so the conversation is stateful
// (you can iterate, then ask Sindri to commit + open a PR via `gh`). Kept under a
// `sindri/` subtree so it never races the forge runner's worktree bookkeeping.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Repository } from "@brokk/core";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 1024 * 1024 * 64 });
  return stdout.trim();
}

/** A legible one-liner from a failed git exec — prefer stderr (the real cause,
 *  e.g. "Authentication failed") over the opaque "spawn git ENOENT". */
function gitErr(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const raw = (err?.stderr || err?.message || String(e)).trim();
  return raw.split("\n").filter(Boolean).slice(0, 3).join(" ").slice(0, 300);
}

export class CheckoutManager {
  constructor(private readonly workDir: string) {}

  private bareDir(repo: Repository): string {
    return join(this.workDir, "repos", `${repo.owner}__${repo.name}.git`);
  }

  private checkoutDir(sessionId: string): string {
    return join(this.workDir, "checkouts", sessionId);
  }

  private refExists(bare: string, ref: string): Promise<boolean> {
    return git(bare, ["rev-parse", "--verify", ref]).then(() => true).catch(() => false);
  }

  /** Ensure the session's worktree exists and return its path + branch. Reuses an
   *  existing checkout (preserving in-progress edits); creates it off base on first
   *  use. Always best-effort fetches base so a brand-new branch starts current. */
  async ensure(opts: {
    sessionId: string;
    branch: string;
    repo: Repository;
    baseBranch: string;
  }): Promise<{ path: string; branch: string }> {
    const { sessionId, branch, repo, baseBranch } = opts;
    const bare = this.bareDir(repo);
    const path = this.checkoutDir(sessionId);
    await mkdir(join(this.workDir, "repos"), { recursive: true });
    await mkdir(join(this.workDir, "checkouts"), { recursive: true });

    // Reuse a healthy existing checkout — keep the session's working state.
    // (Guard on existsSync: running git in a non-existent cwd throws ENOENT.)
    if (existsSync(path)) {
      const healthy = await git(path, ["rev-parse", "--is-inside-work-tree"])
        .then((s) => s === "true")
        .catch(() => false);
      if (healthy) return { path, branch };
    }

    // Ensure the bare mirror exists. Clone on first use and SURFACE a real clone
    // failure (auth, network, bad URL) with context — otherwise a swallowed error
    // leaves `bare` missing and the later `worktree add` (cwd = bare) dies with an
    // opaque "spawn git ENOENT" that hides the actual cause.
    let fresh = false;
    if (!existsSync(join(bare, "HEAD"))) {
      await rm(bare, { recursive: true, force: true }).catch(() => {}); // clear partial clone
      try {
        await git(this.workDir, ["clone", "--bare", repo.cloneUrl, bare]);
        fresh = true;
      } catch (e) {
        await rm(bare, { recursive: true, force: true }).catch(() => {});
        throw new Error(`falha ao clonar ${repo.fullName} (${repo.cloneUrl}): ${gitErr(e)}`);
      }
    }
    await git(bare, ["worktree", "prune"]).catch(() => {});

    // Fork point: refresh base into a remote-tracking ref (never refs/heads/<base>,
    // which another worktree may have checked out), fall back to default branch.
    let startPoint = repo.defaultBranch;
    if (fresh) {
      startPoint = (await this.refExists(bare, `refs/heads/${baseBranch}`))
        ? `refs/heads/${baseBranch}`
        : repo.defaultBranch;
    } else {
      await git(bare, [
        "fetch",
        "origin",
        `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
      ]).catch(() => {});
      if (await this.refExists(bare, `refs/remotes/origin/${baseBranch}`))
        startPoint = `refs/remotes/origin/${baseBranch}`;
    }

    // Clean any stale registration, then add the session branch worktree.
    await git(bare, ["worktree", "remove", "--force", path]).catch(() => {});
    await git(bare, ["worktree", "prune"]).catch(() => {});
    await rm(path, { recursive: true, force: true }).catch(() => {});
    await git(bare, ["worktree", "add", "--force", "-B", branch, path, startPoint]);
    return { path, branch };
  }

  /** Tear down a session's checkout (on delete). Best-effort. */
  async remove(opts: { sessionId: string; repo: Repository }): Promise<void> {
    const bare = this.bareDir(opts.repo);
    const path = this.checkoutDir(opts.sessionId);
    await git(bare, ["worktree", "remove", "--force", path]).catch(() => {});
    await git(bare, ["worktree", "prune"]).catch(() => {});
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}
