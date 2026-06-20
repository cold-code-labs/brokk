/**
 * @brokk/eitri — the forge's second smith.
 *
 * Loop: poll the repo's open PRs → for each head sha not yet reviewed, check out
 * the PR, run the Agent SDK reviewer, post the verdict as a comment, and record
 * it. Standalone daemon — it never touches the forge (runner) machinery; it just
 * shares Brokk's Postgres for its review ledger.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDb, createStore } from "@brokk/db";
import { loadEitriConfig } from "./config.js";
import { EitriGit } from "./git.js";
import { reviewPr } from "./review.js";

const exec = promisify(execFile);

interface OpenPr {
  number: number;
  title: string;
  headRefOid: string;
  author: { login: string };
}

async function listOpenPrs(repo: string, githubToken: string): Promise<OpenPr[]> {
  const { stdout } = await exec(
    "gh",
    ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,headRefOid,author"],
    { env: { ...process.env, GH_TOKEN: githubToken }, maxBuffer: 1024 * 1024 * 8 },
  );
  return JSON.parse(stdout || "[]");
}

async function main() {
  const cfg = loadEitriConfig();
  const { db } = createDb(cfg.databaseUrl);
  const store = createStore(db);
  const git = new EitriGit(cfg);

  console.log(`[eitri] watching ${cfg.repo} every ${cfg.pollIntervalMs / 1000}s`);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    try {
      const prs = await listOpenPrs(cfg.repo, cfg.githubToken);
      for (const pr of prs) {
        if (cfg.skipAuthors.includes(pr.author?.login)) continue;
        if (await store.hasReview(cfg.repo, pr.number, pr.headRefOid)) continue;
        await reviewOne(cfg, store, git, pr).catch((e) =>
          console.error(`[eitri] review of #${pr.number} failed:`, e),
        );
      }
    } catch (e) {
      console.error("[eitri] poll failed:", e);
    }
    await sleep(cfg.pollIntervalMs);
  }
  console.log("[eitri] stopped");
}

async function reviewOne(
  cfg: ReturnType<typeof loadEitriConfig>,
  store: ReturnType<typeof createStore>,
  git: EitriGit,
  pr: OpenPr,
): Promise<void> {
  console.log(`[eitri] reviewing #${pr.number} "${pr.title}" @ ${pr.headRefOid.slice(0, 8)}`);
  const diff = await git.diff(pr.number);
  const cwd = await git.checkoutPr(pr.number);
  try {
    const { verdict, body } = await reviewPr({ cwd, model: cfg.model, prTitle: pr.title, diff });
    const comment = `🛡️ **Eitri** — *the forge's second smith*\n\n${body}`;
    await git.postReview(pr.number, comment, verdict);
    await store.insertReview({
      repo: cfg.repo,
      prNumber: pr.number,
      sha: pr.headRefOid,
      verdict: verdict.toLowerCase(),
      summary: firstParagraph(body),
    });
    console.log(`[eitri] #${pr.number} → ${verdict} (posted)`);
  } finally {
    await git.cleanup(cwd);
  }
}

function firstParagraph(md: string): string {
  const lines = md.split("\n").filter((l) => l.trim() && !/^VERDICT:/i.test(l) && !l.startsWith("#"));
  return (lines[0] ?? "").slice(0, 280);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error("[eitri] fatal:", err);
  process.exit(1);
});
