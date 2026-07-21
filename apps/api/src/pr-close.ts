/**
 * Close the Review → Done loop when a GitHub PR merges (BROKK-45).
 *
 * Pure helpers live here so the webhook + reconciler share one matching policy
 * and unit tests don't need Postgres or `gh`.
 */

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** Strip trailing slash so stored and webhook URLs compare equal. */
export function normalizePrUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** `https://github.com/org/repo/pull/12` → 12 */
export function prNumberFromUrl(url: string): number | null {
  const m = normalizePrUrl(url).match(/\/pull\/(\d+)(?:#|$)/);
  return m ? Number(m[1]) : null;
}

/** `https://github.com/org/repo/pull/12` → `org/repo` */
export function repoFullNameFromPrUrl(url: string): string | null {
  const m = normalizePrUrl(url).match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i);
  return m ? m[1]! : null;
}

/**
 * Forge stamps every PR body with `task \`<uuid>\`` (or `plan \`<uuid>\``).
 * Prefer this over prNumber alone — a re-forge can open #6 while the card still
 * points at closed #5 (Markuplab MARKUPLAB-8).
 */
export function extractTaskIdFromPrBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const task = body.match(new RegExp(`task\\s+\`(${UUID})\``, "i"));
  return task ? task[1]!.toLowerCase() : null;
}

export function extractPlanIdFromPrBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const plan = body.match(new RegExp(`plan\\s+\`(${UUID})\``, "i"));
  return plan ? plan[1]!.toLowerCase() : null;
}

export type PrMatchCandidate = {
  id: string;
  status: string;
  prUrl: string | null;
  prNumber: number | null;
  /** `org/repo` of the card's project, when known. */
  repoFullName?: string | null;
};

/**
 * Pick the card that owns a merged PR. Preference order:
 *  1. Exact prUrl (trailing-slash tolerant)
 *  2. Same repo + same prNumber (never bare number across fleets)
 *  3. Prefer `review` over other statuses
 */
export function selectTaskForMergedPr(
  candidates: PrMatchCandidate[],
  opts: { prUrl: string; prNumber: number; repoFullName?: string | null },
): PrMatchCandidate | null {
  const url = normalizePrUrl(opts.prUrl);
  const repo = opts.repoFullName ?? repoFullNameFromPrUrl(url);

  const scored = candidates
    .map((c) => {
      const cUrl = c.prUrl ? normalizePrUrl(c.prUrl) : null;
      const urlHit = cUrl != null && cUrl === url;
      const sameRepo = !repo || !c.repoFullName || c.repoFullName === repo;
      const numHit = c.prNumber === opts.prNumber && sameRepo && Boolean(repo || c.repoFullName);
      // Last resort: bare number when neither side knows the repo (legacy / tests).
      const bareNum = c.prNumber === opts.prNumber && !repo && !c.repoFullName;
      if (!urlHit && !numHit && !bareNum) return null;
      const score =
        (urlHit ? 100 : 0) +
        (numHit ? 50 : 0) +
        (c.status === "review" ? 10 : 0) +
        (bareNum ? 1 : 0);
      return { c, score };
    })
    .filter((x): x is { c: PrMatchCandidate; score: number } => x != null)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.c ?? null;
}

/** GitHub only closes the board loop on merge — closed≠merged leaves the card. */
export function shouldMarkDoneOnPrClose(pr: { merged?: boolean | null }): boolean {
  return Boolean(pr.merged);
}
