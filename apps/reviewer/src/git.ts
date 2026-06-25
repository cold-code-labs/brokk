import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env, maxBuffer: 1024 * 1024 * 64 });
  return stdout.trim();
}

async function gh(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec("gh", args, { env, maxBuffer: 1024 * 1024 * 32 });
  return stdout.trim();
}

export class EitriGit {
  constructor(
    private readonly opts: { workDir: string; repo: string; cloneUrl: string; githubToken: string },
  ) {}

  private get env() {
    return { ...process.env, GH_TOKEN: this.opts.githubToken };
  }
  /** git over HTTPS authenticated via gh's credential helper (the Eitri image has
   *  gh but no global `gh auth setup-git`, so wire it per-command). Without this,
   *  cloning a private fleet repo fails with "could not read Username". */
  private gitAuthed(cwd: string, args: string[]): Promise<string> {
    return git(
      cwd,
      ["-c", "credential.https://github.com.helper=!gh auth git-credential", ...args],
      this.env,
    );
  }
  private bareDir() {
    return join(this.opts.workDir, "repo.git");
  }

  /** The unified diff of the PR. */
  async diff(prNumber: number): Promise<string> {
    return gh(["pr", "diff", String(prNumber), "--repo", this.opts.repo], this.env);
  }

  /** Repo-relative paths the PR touches — the scope for the security scan. */
  async changedFiles(prNumber: number): Promise<string[]> {
    const out = await gh(
      ["pr", "diff", String(prNumber), "--repo", this.opts.repo, "--name-only"],
      this.env,
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  /** Check out the PR head into an isolated worktree; returns its path. */
  async checkoutPr(prNumber: number): Promise<string> {
    const bare = this.bareDir();
    await mkdir(this.opts.workDir, { recursive: true });
    if (!existsSync(bare)) {
      // Only clone when the bare is actually missing — so a real clone failure
      // (e.g. auth) surfaces instead of being swallowed as "already exists" and
      // then ENOENT-ing on the next git call against a non-existent bare dir.
      await this.gitAuthed(this.opts.workDir, ["clone", "--bare", this.opts.cloneUrl, bare]);
    }
    // Fetch into FETCH_HEAD and check out DETACHED — never a named branch, so a
    // leftover worktree can't trigger "refusing to fetch into checked-out branch".
    await this.gitAuthed(bare, ["fetch", "origin", `pull/${prNumber}/head`]);
    const path = join(this.opts.workDir, "worktrees", `pr-${prNumber}`);
    await git(bare, ["worktree", "remove", "--force", path]).catch(() => {});
    await git(bare, ["worktree", "prune"]).catch(() => {});
    await rm(path, { recursive: true, force: true }).catch(() => {});
    await git(bare, ["worktree", "add", "--force", "--detach", path, "FETCH_HEAD"]);
    return path;
  }

  /** Post the review via the API (works cleanly with App installation tokens).
   *  With its own identity Eitri can approve / request changes; otherwise it can
   *  only comment (GitHub blocks an approval state on your own PR). */
  async postReview(
    prNumber: number,
    body: string,
    verdict: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
    opts: { token: string; canReview: boolean },
  ): Promise<void> {
    const event = !opts.canReview
      ? "COMMENT"
      : verdict === "APPROVE"
        ? "APPROVE"
        : verdict === "REQUEST_CHANGES"
          ? "REQUEST_CHANGES"
          : "COMMENT";
    const [owner, name] = this.opts.repo.split("/");
    await gh(
      ["api", `repos/${owner}/${name}/pulls/${prNumber}/reviews`, "-f", `event=${event}`, "-f", `body=${body}`],
      { ...process.env, GH_TOKEN: opts.token },
    );
  }

  /** Squash-merge the PR (into its base, e.g. dev) and delete the branch. Needs
   *  the posting identity to have Contents: write. */
  async mergePr(prNumber: number, token: string): Promise<void> {
    await gh(
      ["pr", "merge", String(prNumber), "--repo", this.opts.repo, "--squash", "--delete-branch"],
      { ...process.env, GH_TOKEN: token },
    );
  }

  /** Number of the open PR from `head` into `base`, or null if none — the
   *  idempotency check for the promotion PR (#5). */
  async findOpenPr(head: string, base: string): Promise<number | null> {
    const out = await gh(
      ["pr", "list", "--repo", this.opts.repo, "--state", "open", "--head", head, "--base", base, "--json", "number"],
      this.env,
    );
    try {
      const arr = JSON.parse(out) as { number: number }[];
      return arr[0]?.number ?? null;
    } catch {
      return null;
    }
  }

  /** Open a PR from `head` into `base` (no branch delete on merge — promotion
   *  branches like `dev` persist). Returns the new PR number. */
  async openPr(head: string, base: string, title: string, body: string, token: string): Promise<number | null> {
    const url = await gh(
      ["pr", "create", "--repo", this.opts.repo, "--head", head, "--base", base, "--title", title, "--body", body],
      { ...process.env, GH_TOKEN: token },
    );
    const m = url.match(/\/pull\/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  /** Squash-merge a promotion PR WITHOUT deleting the branch (dev must survive). */
  async mergePromotionPr(prNumber: number, token: string): Promise<void> {
    await gh(
      ["pr", "merge", String(prNumber), "--repo", this.opts.repo, "--squash"],
      { ...process.env, GH_TOKEN: token },
    );
  }

  /** Is the PR free of conflicts (safe to merge)?
   *  GitHub often returns UNKNOWN for fresh PRs — poll briefly before giving up. */
  async isMergeable(prNumber: number, retries = 4, delayMs = 5_000): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      const out = await gh(
        ["pr", "view", String(prNumber), "--repo", this.opts.repo, "--json", "mergeable"],
        this.env,
      );
      try {
        const state = JSON.parse(out).mergeable as string;
        if (state === "MERGEABLE") return true;
        if (state === "CONFLICTING") return false;
        // UNKNOWN — GitHub still computing; wait and retry.
        if (i < retries - 1) await sleep(delayMs);
      } catch {
        return false;
      }
    }
    return false;
  }

  async cleanup(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}
