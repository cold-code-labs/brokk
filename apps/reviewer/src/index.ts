/**
 * @brokk/reviewer-app — the forge's second smith.
 *
 * Loop: for every repo in the watch set (each fleet project that forges into
 * `dev`, plus the seed BROKK_DEFAULT_REPO), poll its open PRs → for each head sha
 * not yet reviewed, check out the PR, run the Agent SDK reviewer, post the verdict
 * as a comment, and record it. Standalone daemon — it never touches the forge
 * (runner) machinery; it just shares Brokk's Postgres for its review ledger.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDb, createStore } from "@brokk/db";
import { loadEitriConfig } from "./config.js";
import { EitriGit } from "./git.js";
import { type AppAuth, getInstallationToken, loadAppAuth } from "./github-app.js";
import { reviewPr } from "@brokk/reviewer";
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

/** One repo Eitri watches + the project to attribute its revise tasks to. */
interface WatchRepo {
  repo: string;
  cloneUrl: string;
  projectId: string | null;
}

async function listOpenPrs(repo: string, githubToken: string): Promise<OpenPr[]> {
  const { stdout } = await exec(
    "gh",
    ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,headRefName,baseRefName,headRefOid,author"],
    { env: { ...process.env, GH_TOKEN: githubToken }, maxBuffer: 1024 * 1024 * 8 },
  );
  return JSON.parse(stdout || "[]");
}

/** The watch set, rebuilt every poll so a newly-created dev project is picked up
 *  without a restart: every fleet project on `dev`, unioned with the seed repo. */
async function buildWatchSet(
  store: ReturnType<typeof createStore>,
  cfg: ReturnType<typeof loadEitriConfig>,
  seedProjectId: string | null,
): Promise<WatchRepo[]> {
  const fleet = await store.listFleetDevRepos();
  const set = new Map<string, WatchRepo>();
  for (const r of fleet) set.set(r.fullName, { repo: r.fullName, cloneUrl: r.cloneUrl, projectId: r.projectId });
  // The seed is always watched (e.g. the Brokk dogfood repo, even if it targets main).
  if (cfg.repo && !set.has(cfg.repo)) {
    set.set(cfg.repo, { repo: cfg.repo, cloneUrl: cfg.cloneUrl, projectId: seedProjectId });
  }
  return [...set.values()];
}

async function resolveProjectId(
  store: ReturnType<typeof createStore>,
  repoFullName: string,
): Promise<string | null> {
  const repo = await store.getRepositoryByFullName(repoFullName).catch(() => null);
  if (!repo) return null;
  const proj = (await store.listProjects()).find((p) => p.repositoryId === repo.id);
  return proj?.id ?? null;
}

async function main() {
  const cfg = loadEitriConfig();
  const { db } = createDb(cfg.databaseUrl);
  const store = createStore(db);
  const appAuth = loadAppAuth();

  // One bare clone + worktree dir per repo, created lazily and cached.
  const gits = new Map<string, EitriGit>();
  const gitFor = (repo: string, cloneUrl: string): EitriGit => {
    let g = gits.get(repo);
    if (!g) {
      g = new EitriGit({
        workDir: join(cfg.workDir, repo.replace("/", "__")),
        repo,
        cloneUrl,
        githubToken: cfg.githubToken,
      });
      gits.set(repo, g);
    }
    return g;
  };

  const seedProjectId = cfg.repo ? await resolveProjectId(store, cfg.repo) : null;

  console.log(
    `[eitri] watching the fleet (projects on dev) + seed ${cfg.repo} every ${cfg.pollIntervalMs / 1000}s` +
      (appAuth ? " · identity: GitHub App (Eitri[bot])" : cfg.hasOwnIdentity ? " · identity: own token" : " · identity: shared forge account (comment-only)"),
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    let watch: WatchRepo[] = [];
    try {
      watch = await buildWatchSet(store, cfg, seedProjectId);
    } catch (e) {
      console.error("[eitri] watch-set build failed:", e);
    }
    for (const w of watch) {
      const git = gitFor(w.repo, w.cloneUrl);
      try {
        const prs = await listOpenPrs(w.repo, cfg.githubToken);
        for (const pr of prs) {
          if (cfg.skipAuthors.includes(pr.author?.login)) continue;
          if (await store.hasReview(w.repo, pr.number, pr.headRefOid)) {
            // Review already posted — retry merge if the first attempt was skipped
            // (e.g. GitHub returned mergeable=UNKNOWN right after the PR opened).
            await tryAutoMerge(cfg, store, git, appAuth, w.repo, pr).catch((e) =>
              console.error(`[eitri] ${w.repo}#${pr.number} merge retry failed:`, e),
            );
            continue;
          }
          await reviewOne(cfg, store, git, appAuth, w.repo, w.projectId, pr).catch((e) =>
            console.error(`[eitri] ${w.repo}#${pr.number} review failed:`, e),
          );
        }
      } catch (e) {
        console.error(`[eitri] poll of ${w.repo} failed:`, e);
      }
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
  repo: string,
  projectId: string | null,
  pr: OpenPr,
): Promise<void> {
  console.log(`[eitri] reviewing ${repo}#${pr.number} "${pr.title}" @ ${pr.headRefOid.slice(0, 8)}`);
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
      repo,
      prNumber: pr.number,
      sha: pr.headRefOid,
      verdict: verdict.toLowerCase(),
      summary: firstParagraph(body),
      scanBlocking: scan?.blocking.length ?? 0,
      scanTotal: scan?.findings.length ?? 0,
    });
    console.log(`[eitri] ${repo}#${pr.number} → ${verdict} (posted)`);

    await handleForgeVerdict(cfg, store, git, appAuth, repo, projectId, pr, verdict, body);
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
  repo: string,
  pr: OpenPr,
): Promise<void> {
  if (!pr.headRefName.startsWith("brokk/")) return;
  const reviews = await store.listReviews(repo);
  const review = reviews.find((r) => r.prNumber === pr.number && r.sha === pr.headRefOid);
  if (!review || review.verdict === "request_changes") return;
  await attemptMerge(cfg, store, git, appAuth, repo, pr, review.verdict.toUpperCase());
}

async function handleForgeVerdict(
  cfg: ReturnType<typeof loadEitriConfig>,
  store: ReturnType<typeof createStore>,
  git: EitriGit,
  appAuth: AppAuth | null,
  repo: string,
  projectId: string | null,
  pr: OpenPr,
  verdict: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
  body: string,
): Promise<void> {
  // Only manage forge PRs (brokk/*). Others get a review but no loop/merge.
  if (!pr.headRefName.startsWith("brokk/")) return;

  if (verdict === "REQUEST_CHANGES") {
    // Learn from the rejection (#2): persist the lesson so the planner + the next
    // forge see it and don't repeat the mistake. Keyed by (repo, kind, content),
    // so a recurring failure floats up in weight rather than duplicating.
    await recordReviewFailure(store, repo, pr, body);
    // Blocking → hand the findings back to Brokk to revise the same PR.
    const rounds = (await store.listReviews(repo)).filter((r) => r.prNumber === pr.number).length;
    if (rounds > cfg.maxRevisions) {
      console.log(`[eitri] ${repo}#${pr.number} hit ${cfg.maxRevisions}-round cap — leaving for a human`);
    } else if (await store.openReviseExists(pr.number)) {
      console.log(`[eitri] ${repo}#${pr.number} already has a revise in flight`);
    } else if (!projectId) {
      console.log(`[eitri] ${repo}#${pr.number} REQUEST_CHANGES but no project maps to this repo — skipping revise`);
    } else {
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
        prUrl: `https://github.com/${repo}/pull/${pr.number}`,
        iteration: rounds,
      });
      console.log(`[eitri] ${repo}#${pr.number} → enqueued revise (round ${rounds}/${cfg.maxRevisions})`);
    }
  } else {
    await attemptMerge(cfg, store, git, appAuth, repo, pr, verdict);
  }
}

async function attemptMerge(
  cfg: ReturnType<typeof loadEitriConfig>,
  store: ReturnType<typeof createStore>,
  git: EitriGit,
  appAuth: AppAuth | null,
  repo: string,
  pr: OpenPr,
  verdict: string,
): Promise<void> {
  if (pr.baseRefName === "main") {
    console.log(`[eitri] ${repo}#${pr.number} targets main — not auto-merging (protected)`);
  } else if (!cfg.autoMerge) {
    console.log(`[eitri] ${repo}#${pr.number} mergeable (${verdict}) — auto-merge off, leaving for a human`);
  } else if (!(await git.isMergeable(pr.number))) {
    console.log(`[eitri] ${repo}#${pr.number} not mergeable yet — will retry on next poll`);
  } else {
    try {
      const token = appAuth ? await getInstallationToken(appAuth) : cfg.postToken;
      await git.mergePr(pr.number, token);
      console.log(`[eitri] ${repo}#${pr.number} → MERGED (squash)`);
      // The change is on dev now. Consider promoting dev → prod (#5).
      await maybePromote(cfg, store, git, appAuth, repo, pr, token).catch((e) =>
        console.error(`[eitri] ${repo}#${pr.number} promotion check failed:`, String(e).slice(0, 200)),
      );
    } catch (e) {
      console.error(`[eitri] ${repo}#${pr.number} merge failed (App needs Contents:write?):`, String(e).slice(0, 160));
    }
  }
}

/** Confidence (0..1) that a merged forge change is safe to ship to prod (#5),
 *  from the signals Eitri already has: its verdict, the security scan, and how
 *  many revise rounds the PR needed. A blocking scan finding is an automatic 0;
 *  each extra revise round and each non-blocking finding chips away at trust. */
export function promotionConfidence(opts: {
  verdict: string;
  scanBlocking: number;
  scanTotal: number;
  rounds: number;
}): number {
  if (opts.scanBlocking > 0) return 0;
  const v = opts.verdict.toLowerCase();
  let c = v === "approve" ? 0.9 : v === "comment" ? 0.7 : 0; // request_changes never promotes
  c -= Math.max(0, opts.rounds - 1) * 0.15; // bounced once = fine; repeatedly = risky
  c -= Math.min(0.1, Math.max(0, opts.scanTotal) * 0.02); // non-blocking noise penalty
  return Math.max(0, Math.min(1, c));
}

/** After a forge PR merges into dev, ensure a promotion PR (dev → prod) and, if
 *  confidence clears the bar AND auto-merge is enabled, ship it. Otherwise the PR
 *  is left open as a human escalation — autonomy that's earned, never silent. */
async function maybePromote(
  cfg: ReturnType<typeof loadEitriConfig>,
  store: ReturnType<typeof createStore>,
  git: EitriGit,
  appAuth: AppAuth | null,
  repo: string,
  pr: OpenPr,
  token: string,
): Promise<void> {
  if (!cfg.promote) return;
  const devBranch = pr.baseRefName;
  if (devBranch === cfg.promoteBase) return; // already merged to prod — nothing to promote

  const reviews = (await store.listReviews(repo))
    .filter((r) => r.prNumber === pr.number)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const latest = reviews[0];
  if (!latest) return;
  const confidence = promotionConfidence({
    verdict: latest.verdict,
    scanBlocking: latest.scanBlocking,
    scanTotal: latest.scanTotal,
    rounds: reviews.length,
  });
  const pct = Math.round(confidence * 100);
  const note =
    `Promotion triggered by ${repo}#${pr.number} — “${pr.title}”.\n\n` +
    `**Confidence: ${pct}%** (verdict \`${latest.verdict}\`, ${latest.scanBlocking} blocking / ` +
    `${latest.scanTotal} scan finding(s), ${reviews.length} review round(s)).`;

  // Idempotent: one promotion PR per (dev → prod) window; reuse if open.
  let promoNumber = await git.findOpenPr(devBranch, cfg.promoteBase);
  if (promoNumber == null) {
    promoNumber = await git.openPr(
      devBranch,
      cfg.promoteBase,
      `Promote ${devBranch} → ${cfg.promoteBase}`,
      `🛡️ **Eitri promotion** — *the forge's second smith*\n\n${note}\n\n` +
        `_Threshold for auto-merge: ${Math.round(cfg.promoteMinConfidence * 100)}%; ` +
        `auto-merge ${cfg.promoteAutoMerge ? "ON" : "OFF"}._`,
      token,
    );
    console.log(`[eitri] ${repo} opened promotion PR ${devBranch}→${cfg.promoteBase} (#${promoNumber}) · ${pct}%`);
  } else {
    console.log(`[eitri] ${repo} promotion PR #${promoNumber} already open (${devBranch}→${cfg.promoteBase}) · ${pct}%`);
  }
  if (promoNumber == null) return;

  if (confidence >= cfg.promoteMinConfidence && cfg.promoteAutoMerge) {
    if (await git.isMergeable(promoNumber)) {
      await git.mergePromotionPr(promoNumber, token);
      console.log(`[eitri] ${repo}#${promoNumber} → PROMOTED to ${cfg.promoteBase} (${pct}% ≥ ${Math.round(cfg.promoteMinConfidence * 100)}%)`);
    } else {
      console.log(`[eitri] ${repo}#${promoNumber} promotion not mergeable yet — will retry on next poll`);
    }
  } else {
    console.log(
      `[eitri] ${repo}#${promoNumber} promotion left for a human` +
        ` (${pct}% < ${Math.round(cfg.promoteMinConfidence * 100)}% or auto-merge off)`,
    );
  }
}

/** Persist the lesson from a blocking review (#2). Best-effort; keyed by
 *  (repo, kind, content) so a recurring failure bumps weight, not row count. */
async function recordReviewFailure(
  store: ReturnType<typeof createStore>,
  repo: string,
  pr: OpenPr,
  body: string,
): Promise<void> {
  try {
    const repository = await store.getRepositoryByFullName(repo);
    if (!repository) return;
    const lesson = firstParagraph(body).trim();
    if (!lesson) return;
    await store.recordRepoMemory({
      repositoryId: repository.id,
      kind: "review_failure",
      content: lesson.slice(0, 400),
      source: "eitri",
      prNumber: pr.number,
    });
    console.log(`[eitri] ${repo}#${pr.number} → recorded review-failure memory`);
  } catch (e) {
    console.error(`[eitri] ${repo}#${pr.number} memory record failed:`, String(e).slice(0, 160));
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
