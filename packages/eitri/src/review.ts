/**
 * The reviewer brain. Runs the Claude Agent SDK in the PR's worktree with a
 * skeptical reviewer persona, feeds it the diff, and captures its verdict +
 * markdown review (the agent's final message).
 */
const SYSTEM_PROMPT =
  "You are Eitri, the forge's second smith — an exacting code reviewer. You read the " +
  "changed files in context (the repo is your working directory) and look for real " +
  "problems: correctness bugs, broken edge cases, security issues, sloppy error handling. " +
  "You do NOT modify anything. Be concrete and cite file:line.\n\n" +
  "Your verdict GATES an automated loop, so be decisive:\n" +
  "- REQUEST_CHANGES — ONLY for blocking problems (a real bug, a security hole, something " +
  "that breaks). This sends the PR back to the author to fix.\n" +
  "- COMMENT — the change is correct and safe to merge, but you have non-blocking notes or " +
  "minor suggestions. This is mergeable.\n" +
  "- APPROVE — clean, nothing to add.\n" +
  "Do NOT use REQUEST_CHANGES for style nits or 'could be nicer' — those are COMMENT. A " +
  "correct, safe change must not be blocked. When in doubt between APPROVE and COMMENT, pick COMMENT.";

export type Verdict = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export interface ReviewResult {
  verdict: Verdict;
  body: string;
}

export async function reviewPr(opts: {
  cwd: string;
  model: string;
  prTitle: string;
  diff: string;
  /** Pre-computed security-scan context, injected so the LLM weighs it. */
  scanBlock?: string;
}): Promise<ReviewResult> {
  const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as any;

  const scanSection = opts.scanBlock
    ? ["", "--- SECURITY SCAN ---", opts.scanBlock, "--- END SECURITY SCAN ---", ""]
    : [];

  const prompt = [
    SYSTEM_PROMPT,
    "",
    `Review this pull request: "${opts.prTitle}".`,
    "",
    "The repository is your working directory — open the changed files to understand",
    "the surrounding code before judging. The unified diff is below.",
    ...scanSection,
    "",
    "Reply with a markdown review in EXACTLY this shape:",
    "  First line: `VERDICT: APPROVE` or `VERDICT: COMMENT` or `VERDICT: REQUEST_CHANGES`.",
    "  Then a one-paragraph summary.",
    "  Then a `## Findings` list (file:line — issue), or `No blocking issues found.`",
    "Keep it tight and specific. Do not modify any files.",
    "",
    "```diff",
    opts.diff.slice(0, 60_000),
    "```",
  ].join("\n");

  let text = "";
  const stream = query({
    prompt,
    options: { cwd: opts.cwd, model: opts.model, permissionMode: "bypassPermissions" },
  });
  for await (const m of stream as AsyncIterable<any>) {
    if (m?.type === "result" && typeof m.result === "string") text = m.result;
  }

  const verdict: Verdict = /VERDICT:\s*REQUEST_CHANGES/i.test(text)
    ? "REQUEST_CHANGES"
    : /VERDICT:\s*APPROVE/i.test(text)
      ? "APPROVE"
      : "COMMENT";

  return { verdict, body: text.trim() || "_(Eitri produced no output)_" };
}

export { SYSTEM_PROMPT };
