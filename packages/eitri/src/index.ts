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
import { type AppAuth, getInstallationToken, loadAppAuth } from "./github-app.js";
import { reviewPr } from "./review.js";

const exec = promisify(execFile);

interface OpenPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  author: { login: string };
}

async function listOpenPrs(repo: string, githubToken: string): Promise<OpenPr[]> {
  const { stdout } = await exec(
    "gh",
    ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,headRefName,headRefOid,author"],
    { env: { ...process.env, GH_TOKEN: githubToken }, maxBuffer: 1024 * 1024 * 8 },
  );
  return JSON.parse(stdout || "[]");
}

async function main() {
  const cfg = loadEitriConfig();
  const { db } = createDb(cfg.databaseUrl);
  const store = createStore(db);
  const git = new EitriGit(cfg);
  const appAuth = loadAppAuth();

  console.log(
    `[eitri] watching ${cfg.repo} every ${cfg.pollIntervalMs / 1000}s` +
      (appAuth ? " · identity: GitHub App (Eitri[bot])" : cfg.hasOwnIdentity ? " · identity: own token" : " · identity: shared forge account (comment-only)"),
  );

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
        await reviewOne(cfg, store, git, appAuth, pr).catch((e) =>
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
  appAuth: AppAuth | null,
  pr: OpenPr,
): Promise<void> {
  console.log(`[eitri] reviewing #${pr.number} "${pr.title}" @ ${pr.headRefOid.slice(0, 8)}`);
  const diff = await git.diff(pr.number);
  const cwd = await git.checkoutPr(pr.number);
  try {
    const { verdict, body } = await reviewPr({ cwd, model: cfg.model, prTitle: pr.title, diff });
    const comment = `🛡️ **Eitri** — *the forge's second smith*\n\n${body}`;
    // Post identity: GitHub App token (Eitri[bot]) > own token > shared account.
    const token = appAuth ? await getInstallationToken(appAuth) : cfg.postToken;
    const canReview = Boolean(appAuth) || cfg.hasOwnIdentity;
    await git.postReview(pr.number, comment, verdict, { token, canReview });
    await store.insertReview({
      repo: cfg.repo,
      prNumber: pr.number,
      sha: pr.headRefOid,
      verdict: verdict.toLowerCase(),
      summary: firstParagraph(body),
    });
    console.log(`[eitri] #${pr.number} → ${verdict} (posted)`);

    // The iteration loop: if not approved, hand the findings back to Brokk to
    // revise the same PR — unless it's not a forge PR, the loop is capped, or a
    // revise is already in flight.
    if (verdict !== "APPROVE" && pr.headRefName.startsWith("brokk/")) {
      const rounds = (await store.listReviews(cfg.repo)).filter((r) => r.prNumber === pr.number).length;
      if (rounds > cfg.maxRevisions) {
        console.log(`[eitri] #${pr.number} hit ${cfg.maxRevisions}-round cap — leaving for a human`);
      } else if (await store.openReviseExists(pr.number)) {
        console.log(`[eitri] #${pr.number} already has a revise in flight`);
      } else {
        const projects = await store.listProjects();
        const projectId = projects[0]?.id;
        if (projectId) {
          await store.insertTask({
            projectId,
            kind: "revise",
            status: "queued",
            title: `Revise PR #${pr.number}: ${pr.title}`,
            body: [
              `Address this reviewer (Eitri) feedback on PR #${pr.number} and push fixes to the same branch.`,
              "Make the changes the review asks for; do not open a new PR.",
              "",
              body,
            ].join("\n"),
            prNumber: pr.number,
            branch: pr.headRefName,
            prUrl: `https://github.com/${cfg.repo}/pull/${pr.number}`,
            iteration: rounds,
          });
          console.log(`[eitri] #${pr.number} → enqueued revise (round ${rounds + 1}/${cfg.maxRevisions})`);
        }
      }
    }
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
