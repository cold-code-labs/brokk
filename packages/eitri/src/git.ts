import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 1024 * 1024 * 64 });
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
  private bareDir() {
    return join(this.opts.workDir, "repo.git");
  }

  /** The unified diff of the PR. */
  async diff(prNumber: number): Promise<string> {
    return gh(["pr", "diff", String(prNumber), "--repo", this.opts.repo], this.env);
  }

  /** Check out the PR head into an isolated worktree; returns its path. */
  async checkoutPr(prNumber: number): Promise<string> {
    const bare = this.bareDir();
    await mkdir(this.opts.workDir, { recursive: true });
    try {
      await git(this.opts.workDir, ["clone", "--bare", this.opts.cloneUrl, bare]);
    } catch {
      /* exists */
    }
    // Fetch into FETCH_HEAD and check out DETACHED — never a named branch, so a
    // leftover worktree can't trigger "refusing to fetch into checked-out branch".
    await git(bare, ["fetch", "origin", `pull/${prNumber}/head`]);
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

  async cleanup(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}
