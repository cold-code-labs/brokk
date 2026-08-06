/**
 * The reviewer brain — native over @brokk/afl (NO Agent SDK). Runs the Afl agent
 * loop in the PR's worktree with a skeptical reviewer persona and the READ-ONLY
 * hands (read_file + list_dir + bash, no write/edit, no gh creds), feeds it the
 * diff, and captures its verdict + markdown review (the final assistant message).
 *
 * Auth: prefer Ratatoskr Cursor seat (`CURSOR_SEAT_URL`) when set — same as
 * Sindri cursor-api. Else LiteLLM → Ratatoskr Claude via ANTHROPIC_*.
 * Read-only by construction (§9 #6): the model is never shown a mutating tool, so
 * "do NOT modify anything" is enforced by the tool surface, not just the prompt.
 */
import {
  type AflConfig,
  type ChatTurnMessage,
  composeExecutors,
  FS_READONLY_TOOL_DEFS,
  loadAflConfig,
  makeFsExecutor,
  resolveEnclave,
  resolveModel,
  runAgentLoop,
  type TextBlock,
} from "@brokk/afl";

const SYSTEM_PROMPT =
  "You are Eitri, the forge's second smith — an exacting code reviewer. You read the " +
  "changed files in context (the repo is your working directory) and look for real " +
  "problems: correctness bugs, broken edge cases, security issues, sloppy error handling. " +
  "You do NOT modify anything. Be concrete and cite file:line.\n\n" +
  "Your verdict GATES an automated merge loop — a non-committal review leaves the PR stuck, " +
  "so BE DECISIVE. Every PR must land on APPROVE or REQUEST_CHANGES; COMMENT is a rare middle " +
  "case, never a hedge:\n" +
  "- REQUEST_CHANGES — ONLY for blocking problems (a real bug, a security hole, something " +
  "that breaks). This sends the PR back to the author to fix.\n" +
  "- APPROVE — the change is correct and safe. This is the DEFAULT for any clean, working " +
  "change; it merges. If you have nothing blocking to say, APPROVE.\n" +
  "- COMMENT — reserve for when you have a genuine non-blocking note worth recording but the " +
  "change is still safe to merge. Do NOT use it as a soft 'looks fine' — that is an APPROVE.\n" +
  "Do NOT use REQUEST_CHANGES for style nits or 'could be nicer'. A correct, safe change must " +
  "not be blocked. When in doubt between APPROVE and COMMENT, pick APPROVE — a clean change " +
  "should show a green approval, not sit on a non-committal comment.";

export type Verdict = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

/** One structured finding, so the ledger can give it an identity (ADR 0087). */
export interface ReviewFinding {
  title: string;
  file?: string | null;
  line?: number | null;
  severity: "critical" | "high" | "medium" | "low" | "info";
  body?: string | null;
  /** The test that fails today and passes after the fix. Absent = advisory. */
  proof?: string | null;
}

export interface ReviewResult {
  verdict: Verdict;
  body: string;
  /** Empty when the model emitted no parseable block — never a hard failure. */
  findings: ReviewFinding[];
}

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

/**
 * Pull the findings block out of the review. Best-effort by design: the markdown
 * review is what humans read and must never be lost because a JSON block was
 * malformed. A missing block degrades to "no structured findings", not an error.
 */
/** The machine block is the LAST json fence — the prompt says "append AFTER the
 *  review", and a review of a `package.json` change may quote JSON of its own.
 *  Anchoring to the first fence would parse the quoted snippet and ignore the
 *  real findings. (Caught by Eitri reviewing this very change, PR #92.) */
function lastJsonFence(text: string): string | null {
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  return fences.length ? (fences[fences.length - 1]![1] ?? null) : null;
}

export function parseFindings(text: string): ReviewFinding[] {
  const block = lastJsonFence(text);
  if (!block) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    return [];
  }
  const items = Array.isArray(parsed)
    ? parsed
    : ((parsed as { findings?: unknown }).findings ?? []);
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw): ReviewFinding[] => {
    const it = raw as Record<string, unknown>;
    const title = typeof it.title === "string" ? it.title.trim() : "";
    if (!title) return [];
    const sev = String(it.severity ?? "").toLowerCase();
    return [
      {
        title,
        file: typeof it.file === "string" ? it.file : null,
        line: Number.isInteger(it.line) ? (it.line as number) : null,
        severity: (SEVERITIES as readonly string[]).includes(sev)
          ? (sev as ReviewFinding["severity"])
          : "medium",
        body: typeof it.body === "string" ? it.body : null,
        proof: typeof it.proof === "string" && it.proof.trim() ? it.proof : null,
      },
    ];
  });
}

/** Strip the machine block so the PR comment stays human-readable. Strips the
 *  SAME fence parseFindings read — the last one — so the two never disagree. */
export function stripFindingsBlock(text: string): string {
  const fences = [...text.matchAll(/```json\s*[\s\S]*?```/g)];
  const last = fences[fences.length - 1];
  if (!last || last.index === undefined) return text.trimEnd();
  return (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trimEnd();
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
    "AFTER the review, append ONE fenced ```json block — the same findings, machine-readable,",
    "so they can be tracked across pushes instead of re-raised every time:",
    '  {"findings":[{"title":"…","file":"path.ts","line":12,"severity":"critical|high|medium|low|info",',
    '   "body":"why it breaks","proof":"the test that fails today and passes after the fix"}]}',
    "Omit `proof` when you cannot name such a test — do NOT invent one.",
    "Emit `{\"findings\":[]}` when there is nothing blocking. One finding per real defect,",
    "and keep the `title` describing the DEFECT (not the file), since it is the identity.",
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

/**
 * Prefer Ratatoskr Cursor seat (:8791) when configured — fleet default after
 * Claude Max OAuth org blocks. Same pattern as Sindri `cursor-api`.
 */
export function loadEitriAflConfig(env = process.env): AflConfig {
  const base = loadAflConfig(env);
  const seat = (env.CURSOR_SEAT_URL || env.CURSOR_BRIDGE_URL || "").replace(/\/$/, "");
  if (!seat) return base;
  const token =
    env.CURSOR_SEAT_INGRESS ||
    env.CURSOR_INGRESS_KEYS?.split(",")[0]?.trim() ||
    env.CURSOR_API_KEY ||
    env.CURSOR_AUTH_TOKEN ||
    base.authToken;
  return { ...base, authKind: "bearer", authToken: token, gatewayUrl: seat };
}

export async function reviewPr(opts: {
  cwd: string;
  model: string;
  prTitle: string;
  diff: string;
  /** Pre-computed security-scan context, injected so the LLM weighs it. */
  scanBlock?: string;
  /** Gateway config; defaults to Cursor seat when set, else LiteLLM/Claude. */
  cfg?: AflConfig;
  signal?: AbortSignal;
}): Promise<ReviewResult> {
  const cfg = opts.cfg ?? loadEitriAflConfig();
  const model = resolveModel(cfg, opts.model);
  // Read-only hands, no gh creds — the reviewer inspects, never pushes.
  const exec = composeExecutors(
    makeFsExecutor({ cwd: opts.cwd, gh: false, enclave: resolveEnclave({ checkoutRoot: opts.cwd }) }),
  );
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
  const findings = parseFindings(text);
  const body = stripFindingsBlock(text) || "_(Eitri produced no output)_";
  return { verdict: parseVerdict(text), body, findings };
}

export { SYSTEM_PROMPT };
