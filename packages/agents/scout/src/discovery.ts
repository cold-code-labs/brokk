// ─────────────────────────────────────────────────────────────────────────────
// Huginn — the discovery scout. Odin's raven that flies over the codebase and
// reports back. Given a fresh read-only checkout, it explores (README, structure,
// entrypoints, package manifests, routes, docs, git log) using a single `bash`
// tool, then calls `submit_brief` exactly once with a structured product brief:
// the mission, what's BUILT, what's MISSING, and the stack. That brief is the raw
// material for an auto-proposed backlog (Phase 2: brief → Mímir plan → cards).
//
// One-shot and read-only by construction: the only tool besides submit_brief is
// bash, run in the checkout — Huginn reads, never writes or pushes.
// ─────────────────────────────────────────────────────────────────────────────

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AflConfig } from "@brokk/afl";
import { resolveModel } from "@brokk/afl";
import { streamAssistant } from "@brokk/afl";
import { shellEnv } from "@brokk/afl";
import type { ChatTurnMessage, ContentBlock, ToolDef, ToolResultBlock, ToolUseBlock } from "@brokk/afl";

const execAsync = promisify(exec);
const MAX_OUT = 40_000;

/** The structured product brief Huginn emits (the content half of ProjectBrief). */
export interface DiscoveryBrief {
  mission: string;
  summary: string;
  built: string[];
  missing: string[];
  stack: string[];
}

export interface RunDiscoveryInput {
  cfg: AflConfig;
  /** Read-only checkout the scout explores. */
  cwd: string;
  /** owner/name, for context in the prompt. */
  repoFullName: string;
  /** Model alias or id (default: haiku — cheap, and the fleet is haiku-first). */
  model?: string;
  /** Hard cap on exploration rounds before we force a conclusion. */
  maxRounds?: number;
  signal?: AbortSignal;
  /** Optional progress sink (tool calls, round markers) for logging. */
  onProgress?: (note: string) => void;
}

const BRIEF_TOOL: ToolDef = {
  name: "submit_brief",
  description:
    "Submit the final product brief for this repository. Call this EXACTLY ONCE, after you have explored enough to be concrete. Do not call any other tool in the same turn.",
  input_schema: {
    type: "object",
    properties: {
      mission: {
        type: "string",
        description: "One or two sentences: the product's core purpose — what it is and who it's for.",
      },
      summary: {
        type: "string",
        description: "A short paragraph: what the project is and its current state of maturity.",
      },
      built: {
        type: "array",
        items: { type: "string" },
        description: "Implemented capabilities. Each a concrete bullet, ideally citing a real file/area.",
      },
      missing: {
        type: "array",
        items: { type: "string" },
        description:
          "Gaps, unfinished work, or the most likely next steps. Each item must be concrete and phrasable as ONE actionable task (so it can become a plan-card).",
      },
      stack: {
        type: "array",
        items: { type: "string" },
        description: "Key technologies / frameworks / languages detected.",
      },
    },
    required: ["mission", "summary", "built", "missing", "stack"],
  },
};

const BASH_TOOL: ToolDef = {
  name: "bash",
  description:
    "Run a read-only shell command in the repository root to explore it: cat, ls, find, grep/rg, head, git log, etc. Returns combined stdout+stderr. Do NOT modify, write, or push anything.",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

const SYSTEM = `You are Huginn, Brokk's discovery scout — a raven that surveys a codebase and reports what it is and what it needs.

You are given a read-only git checkout of a repository. Explore it with the bash tool to understand the product, then submit ONE structured brief.

How to explore (be EFFICIENT — aim to conclude within ~10 commands; you do NOT need to read everything, a representative sample is enough even for a large repo):
- Read the README and any docs/ first — they state the mission.
- List the top-level structure (ls, find -maxdepth 2) and read the root + a couple of package manifests for the stack and scripts.
- Skim the main entrypoints, routes, and feature folders to see what's actually built.
- Use git log --oneline -20 to sense momentum and recent direction.
- Don't exhaustively read every package — once you grasp the shape, submit. A large monorepo does not need a file-by-file tour.

Then call submit_brief with:
- mission: the product's purpose in 1-2 sentences (infer it from README + code, don't invent).
- summary: a short paragraph on what it is and how mature it is.
- built: concrete bullets of what's implemented (cite real files/areas).
- missing: concrete, ACTIONABLE gaps or next steps — each phrasable as a single task (these become work cards). Prefer real gaps you can see (TODOs, stubs, missing tests, half-finished features, absent docs/CI) over generic advice.
- stack: the key technologies.

Rules: read-only — never write, edit, commit, or push. Be specific and grounded in what you actually saw. Call submit_brief exactly once when ready.`;

function clip(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…[truncated ${s.length - MAX_OUT} chars]` : s;
}

async function runBash(cwd: string, command: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 60_000,
      maxBuffer: 1024 * 1024 * 16,
      // Read-only scout: allowlisted env, NO gh/git creds and no infra secrets.
      env: shellEnv({ gh: false }),
      signal,
    });
    return clip(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim() || "(no output)");
  } catch (e: any) {
    const out = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`.trim();
    return clip(`exit ${e?.code ?? "?"}\n${out || e?.message || String(e)}`);
  }
}

/** Validate + normalize the model's submit_brief input into a DiscoveryBrief. */
function coerceBrief(input: Record<string, unknown>): DiscoveryBrief {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, 40) : [];
  return {
    mission: str(input.mission),
    summary: str(input.summary),
    built: list(input.built),
    missing: list(input.missing),
    stack: list(input.stack),
  };
}

function briefItemCount(b: DiscoveryBrief): number {
  return b.built.length + b.missing.length + b.stack.length;
}

/** A useful brief grounds all three lists. An empty one means the (often forced)
 *  conclusion gave up before enumerating — mission/summary alone isn't enough. */
function isSparse(b: DiscoveryBrief): boolean {
  return b.built.length === 0 || b.missing.length === 0 || b.stack.length === 0;
}

/** Answer every still-open tool_use in the last assistant turn so the message
 *  chain stays valid (the submit one carries `nudge`, siblings get a stub). */
function answerPendingToolUses(messages: ChatTurnMessage[], submitId: string, nudge: string): void {
  const last = messages[messages.length - 1];
  const pending = Array.isArray(last?.content)
    ? (last.content as ContentBlock[]).filter((b): b is ToolUseBlock => b.type === "tool_use")
    : [];
  if (pending.length === 0) {
    messages.push({ role: "user", content: [{ type: "text", text: nudge }] });
    return;
  }
  const blocks: ToolResultBlock[] = pending.map((tu) => ({
    type: "tool_result",
    tool_use_id: tu.id,
    content: tu.id === submitId ? nudge : "Conclude now — do not run more commands.",
    is_error: false,
  }));
  messages.push({ role: "user", content: blocks as ContentBlock[] });
}

/** If the submitted brief came back sparse — empty built/missing/stack, the
 *  signature of haiku leaking the tool-call XML into `summary` under a forced
 *  toolChoice — recover it with up to `maxAttempts` grounded retries that use
 *  AUTO tool-choice (forcing is what causes the leak; letting the model answer
 *  freely makes it generate real list content). Reuses the explored context,
 *  stays on the same model (haiku-first), and keeps whichever brief is richest —
 *  so it can only improve an empty brief, never regress it. */
async function enrichIfSparse(
  input: RunDiscoveryInput,
  model: string,
  messages: ChatTurnMessage[],
  submitBlock: ToolUseBlock,
  maxAttempts = 2,
): Promise<DiscoveryBrief> {
  let best = coerceBrief(submitBlock.input);
  if (!isSparse(best) || input.signal?.aborted) return best;

  const nudge =
    "That brief was too sparse — built, missing, and stack came back empty. Based ONLY on what you already explored, fill in at least 3 concrete `built` items (each citing a real file/area), at least 2 actionable `missing` items, and the key `stack` technologies. Reply with submit_brief, all lists populated. Do not run any more commands.";
  answerPendingToolUses(messages, submitBlock.id, nudge);

  for (let attempt = 0; attempt < maxAttempts && isSparse(best); attempt++) {
    if (input.signal?.aborted) break;
    input.onProgress?.(`brief sparse — enrich retry ${attempt + 1}/${maxAttempts}`);
    const retry = await streamAssistant(
      input.cfg,
      { model, system: SYSTEM, messages, tools: [BASH_TOOL, BRIEF_TOOL], maxTokens: 4096 },
      () => {},
      input.signal,
    );
    messages.push({ role: "assistant", content: retry.blocks });
    const sub = retry.blocks.find((b): b is ToolUseBlock => b.type === "tool_use" && b.name === "submit_brief");
    if (sub) {
      const cand = coerceBrief(sub.input);
      if (briefItemCount(cand) > briefItemCount(best)) best = cand;
      // Keep the chain valid in case we loop once more.
      answerPendingToolUses(messages, sub.id, nudge);
    } else {
      // It ran bash or replied in prose — answer so we can ask again.
      answerPendingToolUses(messages, "", nudge);
    }
  }
  return best;
}

/** Scout a checkout and return a structured product brief. Throws if the model
 *  never submits one within maxRounds (caller marks the brief failed). */
export async function runDiscovery(input: RunDiscoveryInput): Promise<DiscoveryBrief> {
  const { cfg, cwd, repoFullName, signal, onProgress } = input;
  const model = resolveModel(cfg, input.model ?? "haiku");
  const maxRounds = input.maxRounds ?? 20;
  const tools = [BASH_TOOL, BRIEF_TOOL];

  const messages: ChatTurnMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Scout the repository ${repoFullName} in the current checkout and submit its product brief.`,
        },
      ],
    },
  ];

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) throw new Error("discovery aborted");
    onProgress?.(`round ${round}`);

    const result = await streamAssistant(
      cfg,
      { model, system: SYSTEM, messages, tools, maxTokens: 4096 },
      () => {},
      signal,
    );
    messages.push({ role: "assistant", content: result.blocks });

    const toolUses = result.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const brief = toolUses.find((t) => t.name === "submit_brief");
    if (brief) {
      onProgress?.("brief submitted");
      // assistant turn (with this submit_brief) was just pushed above.
      return await enrichIfSparse(input, model, messages, brief);
    }

    if (result.stopReason !== "tool_use" || toolUses.length === 0) {
      // Model stopped without exploring or concluding — nudge it once.
      messages.push({
        role: "user",
        content: [{ type: "text", text: "Keep exploring with bash, then call submit_brief when ready." }],
      });
      continue;
    }

    // Run the bash calls and feed results back.
    const resultBlocks: ToolResultBlock[] = [];
    for (const tu of toolUses) {
      onProgress?.(`bash: ${String((tu.input as { command?: string }).command ?? "").slice(0, 80)}`);
      const out =
        tu.name === "bash"
          ? await runBash(cwd, String((tu.input as { command?: string }).command ?? ""), signal)
          : `unknown tool: ${tu.name}`;
      resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: out, is_error: false });
    }
    messages.push({ role: "user", content: resultBlocks as ContentBlock[] });
  }

  // Exploration budget spent without a voluntary brief (common on large repos,
  // where the scout keeps reading). Force a conclusion: one final call that MUST
  // call submit_brief, so we always get a grounded brief from what it has seen.
  if (signal?.aborted) throw new Error("discovery aborted");
  onProgress?.("forcing conclusion");
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: "You've explored enough. Submit the brief NOW with submit_brief, based on what you've already seen. Do not run any more commands.",
      },
    ],
  });
  const finalResult = await streamAssistant(
    cfg,
    {
      model,
      system: SYSTEM,
      messages,
      tools,
      maxTokens: 4096,
      toolChoice: { type: "tool", name: "submit_brief" },
    },
    () => {},
    signal,
  );
  const forced = finalResult.blocks.find(
    (b): b is ToolUseBlock => b.type === "tool_use" && b.name === "submit_brief",
  );
  if (forced) {
    onProgress?.("brief submitted (forced)");
    // Push the forced assistant turn so enrichIfSparse can answer its tool_use.
    messages.push({ role: "assistant", content: finalResult.blocks });
    return await enrichIfSparse(input, model, messages, forced);
  }
  throw new Error(`discovery did not converge within ${maxRounds} rounds`);
}
