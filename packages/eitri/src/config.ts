/** Eitri — the forge's second smith. A small daemon that watches a repo's open
 *  PRs and reviews each new head sha with the Claude Agent SDK, posting its
 *  verdict as a PR comment. Reuses Brokk's Postgres for its review ledger. */
export interface EitriConfig {
  databaseUrl: string;
  /** "owner/name" of the repo to watch. */
  repo: string;
  cloneUrl: string;
  /** Token used to clone/fetch the repo (the forge account is fine). */
  githubToken: string;
  /** Token Eitri posts reviews WITH. When it's a distinct account (its own bot),
   *  Eitri can Approve / Request changes; otherwise it can only comment. */
  postToken: string;
  hasOwnIdentity: boolean;
  /** Where bare clones + review worktrees live. */
  workDir: string;
  model: string;
  /** Poll interval (ms) between PR scans. */
  pollIntervalMs: number;
  /** Max revise rounds before Eitri stops looping a PR and leaves it for a human. */
  maxRevisions: number;
  /** Auto-merge (squash) a forge PR once it's mergeable (no CHANGES_REQUESTED). */
  autoMerge: boolean;
  /** GitHub login of the forge bot — skip its... no, we review ITS PRs; this is
   *  the login to skip (e.g. dependabot) if ever needed. */
  skipAuthors: string[];
  /** Run the OSS vulnerability scanners (semgrep + trivy) before each review. */
  securityScan: boolean;
  /** semgrep ruleset, e.g. "auto" (registry) or "p/security-audit". */
  semgrepConfig: string;
  /** Minimum scanner severity (in changed files) that forces REQUEST_CHANGES. */
  scanBlockSeverity: "critical" | "high" | "medium" | "low";
}

export function loadEitriConfig(env = process.env): EitriConfig {
  const repo = env.BROKK_DEFAULT_REPO ?? "";
  if (!repo.includes("/")) throw new Error("BROKK_DEFAULT_REPO (owner/name) is required for Eitri");
  const databaseUrl = env.BROKK_DATABASE_URL ?? "";
  if (!databaseUrl) throw new Error("BROKK_DATABASE_URL is required for Eitri");
  return {
    databaseUrl,
    repo,
    cloneUrl: `https://github.com/${repo}.git`,
    githubToken: env.GITHUB_TOKEN ?? "",
    postToken: env.EITRI_GITHUB_TOKEN || env.GITHUB_TOKEN || "",
    hasOwnIdentity: Boolean(env.EITRI_GITHUB_TOKEN),
    workDir: env.EITRI_WORKDIR ?? "/tmp/eitri",
    model: env.EITRI_MODEL ?? env.BROKK_DEFAULT_MODEL ?? "sonnet",
    pollIntervalMs: Number(env.EITRI_POLL_MS ?? 30_000),
    maxRevisions: Number(env.EITRI_MAX_REVISIONS ?? 3),
    autoMerge: env.EITRI_AUTO_MERGE !== "false",
    skipAuthors: (env.EITRI_SKIP_AUTHORS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    securityScan: env.EITRI_SECURITY_SCAN !== "false",
    // Pinned pack (not "auto"): "auto" needs metrics ON to resolve rules, which we
    // keep off. p/default is semgrep's curated, low-noise security/correctness set.
    semgrepConfig: env.EITRI_SEMGREP_CONFIG ?? "p/default",
    scanBlockSeverity: normalizeSeverity(env.EITRI_SCAN_BLOCK_SEVERITY),
  };
}

function normalizeSeverity(v?: string): "critical" | "high" | "medium" | "low" {
  const s = (v ?? "high").toLowerCase();
  return s === "critical" || s === "medium" || s === "low" ? s : "high";
}
