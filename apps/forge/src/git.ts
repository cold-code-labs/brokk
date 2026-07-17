import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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

  private refExists(bare: string, ref: string): Promise<boolean> {
    return git(bare, ["rev-parse", "--verify", ref]).then(() => true).catch(() => false);
  }

  /** Refresh REMOTE-TRACKING refs and return the freshest start point to fork from.
   *  Never fetches into `refs/heads/*`: the preview supervisor may have a branch
   *  checked out in a persistent worktree of this same bare clone, and git refuses
   *  to fetch into a checked-out branch. Fetches every branch rather than just base
   *  — this bare has no remote.origin.fetch, so a narrow refspec leaves the rest
   *  pinned to their clone-time values, which is how `origin/main` becomes a fossil
   *  that reads as truth. */
  private async resolveBase(bare: string, baseBranch: string, defaultBranch: string): Promise<string> {
    await git(bare, ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"]).catch(() => {});
    if (await this.refExists(bare, `refs/remotes/origin/${baseBranch}`)) return `refs/remotes/origin/${baseBranch}`;
    if (await this.refExists(bare, `refs/heads/${baseBranch}`)) return `refs/heads/${baseBranch}`;
    return defaultBranch; // base not created on the remote yet → fork off default
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

    let fresh = false;
    try {
      await git(this.opts.workDir, ["clone", "--bare", "-c", "core.sharedRepository=group", repo.cloneUrl, bare]);
      fresh = true;
    } catch {
      /* bare already exists — refreshed below */
    }
    // Drop bookkeeping for worktrees whose dirs were already removed.
    await git(bare, ["worktree", "prune"]).catch(() => {});

    // Fork point: on a fresh bare clone every remote head is a local ref, so the
    // base is already present; otherwise refresh it into a remote-tracking ref
    // (never refs/heads/<base>, which the preview may have checked out).
    const startPoint = fresh
      ? (await this.refExists(bare, `refs/heads/${baseBranch}`)) ? `refs/heads/${baseBranch}` : repo.defaultBranch
      : await this.resolveBase(bare, baseBranch, repo.defaultBranch);

    const path = join(this.opts.workDir, "worktrees", branch.replace(/[/]/g, "__"));
    await git(bare, ["worktree", "add", "-b", branch, path, startPoint]);
    return { path, branch };
  }

  /** Worktree on a plan's SHARED feature branch. The first card forks it off
   *  `baseBranch`; later cards continue from the branch's current remote tip (so
   *  each card sees the prior cards' commits). All cards push here → ONE PR. */
  async featureWorktree(opts: {
    repo: Repository;
    baseBranch: string;
    featureBranch: string;
  }): Promise<{ path: string; branch: string; firstCard: boolean }> {
    const { repo, baseBranch, featureBranch } = opts;
    const bare = this.bareDir(repo);
    await mkdir(join(this.opts.workDir, "repos"), { recursive: true });
    let fresh = false;
    try {
      await git(this.opts.workDir, ["clone", "--bare", "-c", "core.sharedRepository=group", repo.cloneUrl, bare]);
      fresh = true;
    } catch {
      /* bare already exists */
    }
    await git(bare, ["worktree", "prune"]).catch(() => {});

    // Fork point for the first card — never fetch into refs/heads/<base> (the
    // preview may have it checked out); use a remote-tracking ref on a warm clone.
    const baseRef = fresh
      ? (await this.refExists(bare, `refs/heads/${baseBranch}`)) ? `refs/heads/${baseBranch}` : repo.defaultBranch
      : await this.resolveBase(bare, baseBranch, repo.defaultBranch);

    // Does the feature branch already exist on the remote? (i.e. a prior card
    // pushed it). If so, continue from its tip; otherwise fork off base.
    const hasFeature = await git(bare, ["fetch", "origin", `refs/heads/${featureBranch}`])
      .then(() => true)
      .catch(() => false);

    const path = join(this.opts.workDir, "worktrees", featureBranch.replace(/[/]/g, "__"));
    await git(bare, ["worktree", "remove", "--force", path]).catch(() => {});
    await git(bare, ["worktree", "prune"]).catch(() => {});
    await rm(path, { recursive: true, force: true }).catch(() => {});

    if (hasFeature) {
      await git(bare, ["worktree", "add", "--force", "-B", featureBranch, path, "FETCH_HEAD"]);
    } else {
      await git(bare, ["worktree", "add", "-b", featureBranch, path, baseRef]);
    }
    return { path, branch: featureBranch, firstCard: !hasFeature };
  }

  /** Check out an existing remote branch (a PR head) to revise in place. Fetches
   *  to FETCH_HEAD and resets a local branch of the same name onto it, so a later
   *  `push origin <branch>` fast-forwards the PR. */
  async checkoutBranch(opts: { repo: Repository; branch: string }): Promise<{ path: string; branch: string }> {
    const { repo, branch } = opts;
    const bare = this.bareDir(repo);
    await mkdir(join(this.opts.workDir, "repos"), { recursive: true });
    try {
      await git(this.opts.workDir, ["clone", "--bare", "-c", "core.sharedRepository=group", repo.cloneUrl, bare]);
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

  /** ADR 0017 dev-lane: stage the agent's edits and commit+push them straight to
   *  `branch` (dev), but ONLY if there's something to commit — no empty commits
   *  polluting dev history when a card lands a no-op. Returns the pushed sha, or
   *  null if the working tree was clean. Fast-forwards origin/<branch>. */
  async commitPushIfChanged(opts: {
    cwd: string;
    branch: string;
    message: string;
  }): Promise<string | null> {
    const name = process.env.BROKK_GIT_NAME ?? "Brokk";
    const email = process.env.BROKK_GIT_EMAIL ?? "brokk@coldcodelabs.com";
    const ident = ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
    await git(opts.cwd, ["add", "-A"]);
    const staged = await git(opts.cwd, ["diff", "--cached", "--name-only"]);
    if (!staged.trim()) return null; // nothing changed → nothing to land
    await git(opts.cwd, [...ident, "commit", "-m", opts.message]);
    // HEAD:<branch> fast-forwards origin/<branch> whether the worktree is on a local
    // branch or (dev-lane) a detached HEAD.
    await git(opts.cwd, ["push", "origin", `HEAD:${opts.branch}`]);
    return git(opts.cwd, ["rev-parse", "HEAD"]);
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
    /** ADR 0017: a card holds this checkout's lease — serve the working tree as-is
     *  (skip fetch + `reset --hard`, which would clobber the agent's uncommitted
     *  edits that HMR is showing live). Only honoured when the worktree already
     *  exists; a missing one is still created. */
    noRefresh?: boolean;
    /** ADR 0017 dev-lane: check out a DETACHED HEAD at the branch tip instead of a
     *  local `<branch>` ref. A local branch can only be checked out in ONE worktree,
     *  and the preview already owns `dev` in its own worktree — the card's private
     *  checkout would collide ("cannot force update the branch 'dev' used by worktree
     *  …"). Detached lets the card land commits on origin/<branch> (push HEAD:<branch>)
     *  without owning the local branch. */
    detach?: boolean;
  }): Promise<{ path: string; branch: string }> {
    const { repo, branch, name, noRefresh, detach } = opts;
    const path = join(this.opts.workDir, "preview-worktrees", name);
    if (noRefresh && existsSync(path)) return { path, branch };
    const bare = this.bareDir(repo);
    await mkdir(join(this.opts.workDir, "repos"), { recursive: true });

    // Ensure bare repo exists, then always fetch to get the latest commits.
    try {
      await git(this.opts.workDir, ["clone", "--bare", "-c", "core.sharedRepository=group", repo.cloneUrl, bare]);
    } catch {
      /* already exists — fall through to fetch below */
    }
    // Retroactively share pre-existing bares too: objects + fanout dirs become
    // group-writable (setgid) so the worker (uid 1001) and the agent's sandboxed
    // bash (egress uid 1002, shared gid 1001) can BOTH add objects without EACCES.
    // git ignores umask for objects, so this config — not umask — is the lever for
    // the "insufficient permission for adding an object" wedge. (brokk-dev-preview)
    await git(bare, ["config", "core.sharedRepository", "group"]).catch(() => {});
    // Fetch to FETCH_HEAD, NOT into refs/heads/<branch>: git refuses to update a
    // branch ref that's checked out in the persistent worktree ("refusing to
    // fetch into branch ... checked out").
    await git(bare, ["fetch", "origin", `refs/heads/${branch}`]);
    await git(bare, ["worktree", "prune"]).catch(() => {});

    await mkdir(join(this.opts.workDir, "preview-worktrees"), { recursive: true });

    // Resolve the fetched tip to a SHA *here, in the bare*. FETCH_HEAD is a
    // per-worktree ref: each worktree gitdir keeps its own. Naming it in a command
    // run inside the worktree (below) resolves the WORKTREE's FETCH_HEAD — written
    // by refreshCheckout's own fetch, not by the one above — so the reuse path
    // would reset onto a stale tip and still report success. That pinned the viken
    // preview 29 commits behind for days: it never went 'live', so the live-only
    // drift refresh never re-fetched, and every boot reset it back onto the same
    // frozen sha.
    const tip = await git(bare, ["rev-parse", "FETCH_HEAD"]);

    // Try to refresh an existing worktree (the "reuse" path — no teardown):
    // reset onto the freshly fetched tip.
    const refreshed = await git(path, ["reset", "--hard", tip])
      .then(() => true)
      .catch(() => false);
    if (refreshed) return { path, branch };

    // First boot (or broken worktree): recreate from the fetched tip. Tear down
    // any stale worktree at this path FIRST — otherwise `worktree add` aborts with
    // "'<path>' already exists" (an orphaned dir) or "'<branch>' is already used by
    // worktree" (a stale registration). Let git remove it (drops the registration
    // AND the dir together when it can), then rm any leftover dir, then prune so
    // git forgets any registration still pinning `branch` to the old path.
    await git(bare, ["worktree", "remove", "--force", path]).catch(() => {});
    await rm(path, { recursive: true, force: true }).catch(() => {});
    await git(bare, ["worktree", "prune"]).catch(() => {});

    // If the dir SURVIVED that cleanup, it holds files this process (the runner
    // uid) can't remove — the fingerprint of a run that crashed mid-forge under
    // the isolation enclave, leaving objects/node_modules owned by another uid.
    // Fail LOUD with the exact fix instead of letting `worktree add` wedge every
    // future card for this app on a cryptic "already exists". See the git.ts
    // note in brokk-dev-preview and the enclave-uid follow-up.
    if (existsSync(path)) {
      throw new Error(
        `persistentCheckout: could not remove stale worktree dir ${path} ` +
          `(contains files not owned by the runner uid — likely a crashed run under the enclave). ` +
          `Clean it as root, then retry: rm -rf ${path} && git -C ${bare} worktree prune`,
      );
    }

    // Detached (dev-lane card): no local branch, so it never collides with the
    // preview's `<branch>` worktree. Otherwise bind the local branch (preview path).
    await git(
      bare,
      detach
        ? ["worktree", "add", "--detach", "--force", path, "FETCH_HEAD"]
        : ["worktree", "add", "--force", "-B", branch, path, "FETCH_HEAD"],
    );
    return { path, branch };
  }
}
