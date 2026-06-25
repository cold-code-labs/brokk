/**
 * The reviewer brain — native over @brokk/afl (NO Agent SDK). Runs the Afl agent
 * loop in the PR's worktree with a skeptical reviewer persona and the READ-ONLY
 * hands (read_file + list_dir + bash, no write/edit, no gh creds), feeds it the
 * diff, and captures its verdict + markdown review (the final assistant message).
 *
 * Auth is gateway-only (LiteLLM → Ratatoskr) via afl's loadChatConfig — the same
 * ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN the eitri container already carries.
 * Read-only by construction (§9 #6): the model is never shown a mutating tool, so
 * "do NOT modify anything" is enforced by the tool surface, not just the prompt.
 */
import {
  type ChatConfig,
  type ChatTurnMessage,
  composeExecutors,
  FS_READONLY_TOOL_DEFS,
  loadChatConfig,
  makeFsExecutor,
  resolveModel,
  runAgentLoop,
  type TextBlock,
} from "@brokk/afl";

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

/** Build the user turn: the review request + the diff. The persona is delivered
 *  separately as the API `system` (cacheable, not re-sent in the prompt). */
function buildReviewPrompt(opts: { prTitle: string; diff: string; scanBlock?: string }): string {
  const scanSection = opts.scanBlock
    ? ["", "--- SECURITY SCAN ---", opts.scanBlock, "--- END SECURITY SCAN ---", ""]
    : [];
  return [
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
}

function parseVerdict(text: string): Verdict {
  return /VERDICT:\s*REQUEST_CHANGES/i.test(text)
    ? "REQUEST_CHANGES"
    : /VERDICT:\s*APPROVE/i.test(text)
      ? "APPROVE"
      : "COMMENT";
}

export async function reviewPr(opts: {
  cwd: string;
  model: string;
  prTitle: string;
  diff: string;
  /** Pre-computed security-scan context, injected so the LLM weighs it. */
  scanBlock?: string;
  /** Gateway config; defaults to loadChatConfig() (the eitri container's env). */
  cfg?: ChatConfig;
  signal?: AbortSignal;
}): Promise<ReviewResult> {
  const cfg = opts.cfg ?? loadChatConfig();
  const model = resolveModel(cfg, opts.model);
  // Read-only hands, no gh creds — the reviewer inspects, never pushes.
  const exec = composeExecutors(makeFsExecutor({ cwd: opts.cwd, gh: false }));
  const messages: ChatTurnMessage[] = [
    { role: "user", content: [{ type: "text", text: buildReviewPrompt(opts) }] },
  ];

  // The review is the LAST non-empty assistant text — after the agent has read the
  // files it wanted (intermediate turns carry the read_file/bash calls), the final
  // end_turn message is the verdict.
  let lastText = "";
  await runAgentLoop({
    cfg,
    model,
    system: SYSTEM_PROMPT,
    messages,
    tools: FS_READONLY_TOOL_DEFS,
    exec,
    // A review body (summary + findings) is small; give it headroom over chat's
    // default. The gateway shrinks it on a busy-seat 429.
    maxTokens: Math.max(cfg.maxTokens, 4096),
    maxRounds: Number(process.env.EITRI_MAX_ROUNDS ?? 24),
    signal: opts.signal,
    hooks: {
      onAssistant: (blocks) => {
        const t = blocks
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (t.trim()) lastText = t;
      },
    },
  });

  const text = lastText.trim();
  return { verdict: parseVerdict(text), body: text || "_(Eitri produced no output)_" };
}

export { SYSTEM_PROMPT };
