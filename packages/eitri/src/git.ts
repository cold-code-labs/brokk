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
  constructor(private readonly opts: { workDir: string; repo: string; cloneUrl: string; githubToken: string }) {}

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
    const ref = `eitri/pr-${prNumber}`;
    await git(bare, ["fetch", "origin", `+pull/${prNumber}/head:${ref}`]);
    await git(bare, ["worktree", "prune"]).catch(() => {});
    const path = join(this.opts.workDir, "worktrees", `pr-${prNumber}`);
    await rm(path, { recursive: true, force: true }).catch(() => {});
    await git(bare, ["worktree", "add", "--force", path, ref]);
    return path;
  }

  /** Post the review as a comment (a shared bot identity can't approve its own
   *  PRs; a dedicated Eitri account unlocks approve/request-changes later). */
  async postReview(prNumber: number, body: string): Promise<void> {
    await gh(["pr", "review", String(prNumber), "--repo", this.opts.repo, "--comment", "--body", body], this.env);
  }

  async cleanup(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}
