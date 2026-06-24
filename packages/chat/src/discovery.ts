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
import type { ChatConfig } from "./config.js";
import { resolveModel } from "./config.js";
import { streamAssistant } from "./gateway.js";
import type { ChatTurnMessage, ContentBlock, ToolDef, ToolResultBlock, ToolUseBlock } from "./types.js";

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
  cfg: ChatConfig;
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

How to explore (be efficient, ~6-15 commands):
- Read the README and any docs/ first — they state the mission.
- List the top-level structure (ls, find -maxdepth 2) and read package manifests (package.json, etc.) for the stack and scripts.
- Skim the main entrypoints, routes, and feature folders to see what's actually built.
- Use git log --oneline -20 to sense momentum and recent direction.

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
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
      { model, system: SYSTEM, messages, tools, maxTokens: 2048 },
      () => {},
      signal,
    );
    messages.push({ role: "assistant", content: result.blocks });

    const toolUses = result.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const brief = toolUses.find((t) => t.name === "submit_brief");
    if (brief) {
      onProgress?.("brief submitted");
      return coerceBrief(brief.input);
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

  throw new Error(`discovery did not converge within ${maxRounds} rounds`);
}
