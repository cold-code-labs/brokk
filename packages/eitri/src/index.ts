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
import { formatScanMarkdown, runScan, scanPromptBlock } from "./scan.js";

const exec = promisify(execFile);

interface OpenPr {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  author: { login: string };
}

async function listOpenPrs(repo: string, githubToken: string): Promise<OpenPr[]> {
  const { stdout } = await exec(
    "gh",
    ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,headRefName,baseRefName,headRefOid,author"],
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
        if (await store.hasReview(cfg.repo, pr.number, pr.headRefOid)) {
          // Review already posted — retry merge if the first attempt was skipped
          // (e.g. GitHub returned mergeable=UNKNOWN right after the PR opened).
          await tryAutoMerge(cfg, store, git, appAuth, pr).catch((e) =>
            console.error(`[eitri] merge retry for #${pr.number} failed:`, e),
          );
          continue;
        }
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
    // Security ward: run the OSS scanners over the worktree, scoped to the PR's
    // changed files. HIGH/CRITICAL findings deterministically gate the verdict.
    const changedFiles = await git.changedFiles(pr.number).catch(() => [] as string[]);
    const scan = await runScan({
      cwd,
      changedFiles,
      config: {
        enabled: cfg.securityScan,
        semgrepConfig: cfg.semgrepConfig,
        blockSeverity: cfg.scanBlockSeverity,
      },
    }).catch((e) => {
      console.error(`[eitri] scan of #${pr.number} failed:`, e);
      return null;
    });
    if (scan?.scanned) {
      console.log(
        `[eitri] #${pr.number} scan: ${scan.blocking.length} blocking / ${scan.findings.length} total` +
          ` (ran ${scan.toolsRun.join(",") || "none"})`,
      );
    }

    const llm = await reviewPr({
      cwd,
      model: cfg.model,
      prTitle: pr.title,
      diff,
      scanBlock: scan ? scanPromptBlock(scan) : undefined,
    });
    // The scan gates independently of the LLM: any blocking finding → REQUEST_CHANGES.
    const gated = Boolean(scan && scan.blocking.length > 0);
    const verdict = gated ? "REQUEST_CHANGES" : llm.verdict;
    const scanMd = scan ? formatScanMarkdown(scan) : "";
    // When the security ward overrides a softer LLM verdict, say so up front so the
    // comment's own "VERDICT: ..." line isn't read as contradictory.
    const banner =
      gated && llm.verdict !== "REQUEST_CHANGES"
        ? `> ⛔ **REQUEST_CHANGES forced by the security ward** — ${scan!.blocking.length} blocking ` +
          `finding(s) in changed files. Eitri's code review (below) judged it \`${llm.verdict}\`.\n\n`
        : "";
    const body = scanMd ? `${banner}${scanMd}\n\n---\n\n${llm.body}` : llm.body;
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
      scanBlocking: scan?.blocking.length ?? 0,
      scanTotal: scan?.findings.length ?? 0,
    });
    console.log(`[eitri] #${pr.number} → ${verdict} (posted)`);

    await handleForgeVerdict(cfg, store, git, appAuth, pr, verdict, body);
  } finally {
    await git.cleanup(cwd);
  }
}

/** After a gate-passing review, squash-merge forge PRs into their base (dev). */
async function tryAutoMerge(
  cfg: ReturnType<typeof loadEitriConfig>,
  store: ReturnType<typeof createStore>,
  git: EitriGit,
  appAuth: AppAuth | null,
  pr: OpenPr,
): Promise<void> {
  if (!pr.headRefName.startsWith("brokk/")) return;
  const reviews = await store.listReviews(cfg.repo);
  const review = reviews.find((r) => r.prNumber === pr.number && r.sha === pr.headRefOid);
  if (!review || review.verdict === "request_changes") return;
  await attemptMerge(cfg, git, appAuth, pr, review.verdict.toUpperCase());
}

async function handleForgeVerdict(
  cfg: ReturnType<typeof loadEitriConfig>,
  store: ReturnType<typeof createStore>,
  git: EitriGit,
  appAuth: AppAuth | null,
  pr: OpenPr,
  verdict: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
  body: string,
): Promise<void> {
  // Only manage forge PRs (brokk/*). Others get a review but no loop/merge.
  if (!pr.headRefName.startsWith("brokk/")) return;

  if (verdict === "REQUEST_CHANGES") {
    // Blocking → hand the findings back to Brokk to revise the same PR.
    const rounds = (await store.listReviews(cfg.repo)).filter((r) => r.prNumber === pr.number).length;
    if (rounds > cfg.maxRevisions) {
      console.log(`[eitri] #${pr.number} hit ${cfg.maxRevisions}-round cap — leaving for a human`);
    } else if (await store.openReviseExists(pr.number)) {
      console.log(`[eitri] #${pr.number} already has a revise in flight`);
    } else {
      const projectId = (await store.listProjects())[0]?.id;
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
        console.log(`[eitri] #${pr.number} → enqueued revise (round ${rounds}/${cfg.maxRevisions})`);
      }
    }
  } else {
    await attemptMerge(cfg, git, appAuth, pr, verdict);
  }
}

async function attemptMerge(
  cfg: ReturnType<typeof loadEitriConfig>,
  git: EitriGit,
  appAuth: AppAuth | null,
  pr: OpenPr,
  verdict: string,
): Promise<void> {
  if (pr.baseRefName === "main") {
    console.log(`[eitri] #${pr.number} targets main — not auto-merging (protected)`);
  } else if (!cfg.autoMerge) {
    console.log(`[eitri] #${pr.number} mergeable (${verdict}) — auto-merge off, leaving for a human`);
  } else if (!(await git.isMergeable(pr.number))) {
    console.log(`[eitri] #${pr.number} not mergeable yet — will retry on next poll`);
  } else {
    try {
      const token = appAuth ? await getInstallationToken(appAuth) : cfg.postToken;
      await git.mergePr(pr.number, token);
      console.log(`[eitri] #${pr.number} → MERGED (squash)`);
    } catch (e) {
      console.error(`[eitri] #${pr.number} merge failed (App needs Contents:write?):`, String(e).slice(0, 160));
    }
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
