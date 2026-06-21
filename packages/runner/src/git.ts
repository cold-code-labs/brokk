import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitProvider, Repository } from "@brokk/core";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 1024 * 1024 * 64 });
  return stdout.trim();
}

async function gh(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec("gh", args, { cwd, env, maxBuffer: 1024 * 1024 * 16 });
  return stdout.trim();
}

/**
 * Git/GitHub provider over the `git` and `gh` CLIs (ARCHITECTURE.md §8/§10).
 * Uses a cached bare clone per repo + a fresh worktree per run for isolation.
 */
export class GhProvider implements GitProvider {
  constructor(
    private readonly opts: { workDir: string; githubToken: string },
  ) {}

  private bareDir(repo: Repository): string {
    return join(this.opts.workDir, "repos", `${repo.owner}__${repo.name}.git`);
  }

  /** Clone (or fetch) a cached bare repo, then add a worktree on a new branch. */
  async worktree(opts: {
    repo: Repository;
    baseBranch: string;
    branch: string;
  }): Promise<{ path: string; branch: string }> {
    const { repo, baseBranch, branch } = opts;
    const bare = this.bareDir(repo);
    await mkdir(join(this.opts.workDir, "repos"), { recursive: true });

    try {
      await git(this.opts.workDir, ["clone", "--bare", repo.cloneUrl, bare]);
    } catch {
      // Bare already exists → refresh ONLY the base branch. A wildcard fetch
      // (`+refs/heads/*`) would try to clobber the `brokk/*` run branches that
      // are still checked out in worktrees and git refuses ("refusing to fetch
      // into branch ... checked out").
      await git(bare, ["fetch", "origin", `+refs/heads/${baseBranch}:refs/heads/${baseBranch}`]);
    }
    // Drop bookkeeping for worktrees whose dirs were already removed.
    await git(bare, ["worktree", "prune"]).catch(() => {});

    // Bootstrap: if baseBranch doesn't exist in the bare clone yet (e.g. "dev"
    // hasn't been created on the remote), create it off the repo default branch
    // so the worktree add below has a valid start point.
    const baseBranchExists = await git(bare, ["rev-parse", "--verify", `refs/heads/${baseBranch}`]).catch(() => null);
    if (baseBranchExists === null) {
      await git(bare, ["branch", baseBranch, repo.defaultBranch]);
    }

    const path = join(this.opts.workDir, "worktrees", branch.replace(/[/]/g, "__"));
    // A bare clone stores branches as local refs (refs/heads/<branch>), so fork
    // from `baseBranch` directly — there is no `origin/` remote-tracking prefix.
    await git(bare, ["worktree", "add", "-b", branch, path, baseBranch]);
    return { path, branch };
  }

  /** Check out an existing remote branch (a PR head) to revise in place. Fetches
   *  to FETCH_HEAD and resets a local branch of the same name onto it, so a later
   *  `push origin <branch>` fast-forwards the PR. */
  async checkoutBranch(opts: { repo: Repository; branch: string }): Promise<{ path: string; branch: string }> {
    const { repo, branch } = opts;
    const bare = this.bareDir(repo);
    await mkdir(join(this.opts.workDir, "repos"), { recursive: true });
    try {
      await git(this.opts.workDir, ["clone", "--bare", repo.cloneUrl, bare]);
    } catch {
      await git(bare, ["fetch", "origin", `+refs/heads/${repo.defaultBranch}:refs/heads/${repo.defaultBranch}`]);
    }
    await git(bare, ["fetch", "origin", `refs/heads/${branch}`]);
    const path = join(this.opts.workDir, "worktrees", branch.replace(/[/]/g, "__"));
    await git(bare, ["worktree", "remove", "--force", path]).catch(() => {});
    await git(bare, ["worktree", "prune"]).catch(() => {});
    await rm(path, { recursive: true, force: true }).catch(() => {});
    await git(bare, ["worktree", "add", "--force", "-B", branch, path, "FETCH_HEAD"]);
    return { path, branch };
  }

  async push(opts: { cwd: string; branch: string; message: string }): Promise<void> {
    // Self-contained committer identity so the runner doesn't depend on the
    // host's global git config (overridable via env).
    const name = process.env.BROKK_GIT_NAME ?? "Brokk";
    const email = process.env.BROKK_GIT_EMAIL ?? "brokk@coldcodelabs.com";
    const ident = ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
    await git(opts.cwd, ["add", "-A"]);
    // Allow empty so a no-op run still produces a (clearly empty) branch.
    await git(opts.cwd, [...ident, "commit", "-m", opts.message, "--allow-empty"]);
    await git(opts.cwd, ["push", "-u", "origin", opts.branch]);
  }

  async openPr(opts: {
    cwd: string;
    repo: Repository;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<{ url: string; number: number | null }> {
    const env = { ...process.env, GH_TOKEN: this.opts.githubToken };
    const url = await gh(
      opts.cwd,
      [
        "pr",
        "create",
        "--repo",
        opts.repo.fullName,
        "--base",
        opts.baseBranch,
        "--head",
        opts.branch,
        "--title",
        opts.title,
        "--body",
        opts.body,
      ],
      env,
    );
    const m = url.match(/\/pull\/(\d+)/);
    return { url, number: m ? Number(m[1]) : null };
  }

  async cleanup(opts: { path: string }): Promise<void> {
    // git worktree prune would also work; rm is simplest for the scaffold.
    await rm(opts.path, { recursive: true, force: true });
  }

  /** Create (or refresh) a **persistent** worktree for a preview branch.
   *
   *  Unlike forge worktrees (which are torn down after each run), preview
   *  worktrees live under `<workDir>/preview-worktrees/<name>` and are NEVER
   *  deleted — they are refreshed (fetch + `git reset --hard`) on each start so
   *  the app's `node_modules` / build cache survive restarts.
   *
   *  @param name  Stable slug for the worktree directory, e.g. `"brokk-dev"`.
   */
  async persistentCheckout(opts: {
    repo: Repository;
    branch: string;
    name: string;
  }): Promise<{ path: string; branch: string }> {
    const { repo, branch, name } = opts;
    const bare = this.bareDir(repo);
    await mkdir(join(this.opts.workDir, "repos"), { recursive: true });

    // Ensure bare repo exists, then always fetch to get the latest commits.
    try {
      await git(this.opts.workDir, ["clone", "--bare", repo.cloneUrl, bare]);
    } catch {
      /* already exists — fall through to fetch below */
    }
    await git(bare, ["fetch", "origin", `+refs/heads/${branch}:refs/heads/${branch}`]);
    await git(bare, ["worktree", "prune"]).catch(() => {});

    const parentDir = join(this.opts.workDir, "preview-worktrees");
    const path = join(parentDir, name);
    await mkdir(parentDir, { recursive: true });

    // Try to refresh an existing worktree (the "reuse" path — no teardown).
    const refreshed = await git(path, ["reset", "--hard", branch])
      .then(() => true)
      .catch(() => false);
    if (refreshed) return { path, branch };

    // First boot (or broken worktree): create fresh from the fetched branch tip.
    await rm(path, { recursive: true, force: true }).catch(() => {});
    await git(bare, ["worktree", "add", "-B", branch, path, `refs/heads/${branch}`]);
    return { path, branch };
  }
}
