/**
 * The reviewer brain. Runs the Claude Agent SDK in the PR's worktree with a
 * skeptical reviewer persona, feeds it the diff, and captures its verdict +
 * markdown review (the agent's final message).
 */
const SYSTEM_PROMPT =
  "You are Eitri, the forge's second smith — an exacting, skeptical code reviewer. " +
  "You review a pull request and look for real problems: correctness bugs, broken " +
  "edge cases, security issues, sloppy error handling, and clear inconsistencies with " +
  "the surrounding codebase. You read the changed files in context (the repo is your " +
  "working directory). You do NOT modify anything. Be concrete and cite file:line. " +
  "Praise sparingly; focus on what could break. If the change is clean, say so plainly.";

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
}): Promise<ReviewResult> {
  const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as any;

  const prompt = [
    SYSTEM_PROMPT,
    "",
    `Review this pull request: "${opts.prTitle}".`,
    "",
    "The repository is your working directory — open the changed files to understand",
    "the surrounding code before judging. The unified diff is below.",
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
