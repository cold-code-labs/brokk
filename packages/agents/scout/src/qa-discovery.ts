// ─────────────────────────────────────────────────────────────────────────────
// QA Discovery scout — builds a versioned user-scenario catalog for Full QA.
// Sibling of Huginn (product brief): this one answers "what can a user DO?",
// not "what is the product?". Read-only bash explore → submit_scenarios once.
// Fingerprint of routes/features/e2e lets Brokk mark the catalog stale when
// developers ship new surfaces without re-discovering.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AflConfig } from "@brokk/afl";
import { resolveModel } from "@brokk/afl";
import { streamAssistant } from "@brokk/afl";
import { shellEnv } from "@brokk/afl";
import type { ChatTurnMessage, ContentBlock, ToolDef, ToolResultBlock, ToolUseBlock } from "@brokk/afl";

const execAsync = promisify(exec);
const MAX_OUT = 40_000;

export type QaScenarioPriority = "p0" | "p1" | "p2";

export interface QaScenario {
  id: string;
  title: string;
  module: string;
  priority: QaScenarioPriority;
  role: string;
  tags: string[];
  preconditions: string[];
  steps: string[];
  expects: string[];
}

export interface QaDiscoveryResult {
  summary: string;
  fingerprint: string;
  scenarios: QaScenario[];
}

export interface RunQaDiscoveryInput {
  cfg: AflConfig;
  cwd: string;
  repoFullName: string;
  model?: string;
  maxRounds?: number;
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
}

/** Globs / names that define the QA surface — when these drift, re-discover. */
const FINGERPRINT_NAMES = new Set([
  "features.json",
  "app-features.json",
  "modules.ts",
  "features.ts",
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
]);

const FINGERPRINT_DIR_HINTS = ["e2e", "tests/e2e", "src/app", "app", "pages", "src/pages", "src/routes"];

async function walkFiles(root: string, maxFiles = 400): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number) {
    if (out.length >= maxFiles || depth > 6) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= maxFiles) return;
      if (name === "node_modules" || name === ".git" || name === "dist" || name === ".next" || name === "coverage") {
        continue;
      }
      const full = join(dir, name);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const rel = relative(root, full).replace(/\\/g, "/");
        const interesting =
          FINGERPRINT_DIR_HINTS.some((h) => rel === h || rel.startsWith(`${h}/`)) || depth === 0;
        if (interesting || depth < 2) await walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const base = name.toLowerCase();
      const rel = relative(root, full).replace(/\\/g, "/");
      const inE2e = /(^|\/)e2e\//.test(rel) && /\.(ts|js|tsx|jsx)$/.test(base);
      const named = FINGERPRINT_NAMES.has(name);
      const routeish =
        /(^|\/)(app|pages|src\/app|src\/pages|src\/routes)\//.test(rel) &&
        /(page|route|layout)\.(tsx?|jsx?)$/.test(base);
      if (named || inE2e || routeish) out.push(full);
    }
  }
  await walk(root, 0);
  return out.sort();
}

/** Stable hash of QA-relevant sources. Empty repo → fixed sentinel. */
export async function computeQaFingerprint(cwd: string): Promise<string> {
  const files = await walkFiles(cwd);
  const hash = createHash("sha256");
  if (files.length === 0) {
    hash.update("empty");
    return hash.digest("hex").slice(0, 16);
  }
  for (const file of files) {
    const rel = relative(cwd, file).replace(/\\/g, "/");
    hash.update(rel);
    hash.update("\0");
    try {
      const st = await stat(file);
      hash.update(String(st.size));
      hash.update("\0");
      const body = await readFile(file);
      hash.update(body);
    } catch {
      hash.update("missing");
    }
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

const SCENARIOS_TOOL: ToolDef = {
  name: "submit_scenarios",
  description:
    "Submit the final QA scenario catalog for this repository. Call EXACTLY ONCE after exploring enough. Do not call another tool in the same turn.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "One short paragraph: what user journeys this app exposes.",
      },
      scenarios: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable kebab-case id" },
            title: { type: "string" },
            module: { type: "string", description: "auth | nav key | feature key" },
            priority: { type: "string", enum: ["p0", "p1", "p2"] },
            role: { type: "string", description: "any | admin | member | …" },
            tags: { type: "array", items: { type: "string" } },
            preconditions: { type: "array", items: { type: "string" } },
            steps: { type: "array", items: { type: "string" } },
            expects: { type: "array", items: { type: "string" } },
          },
          required: ["id", "title", "module", "priority", "steps", "expects"],
        },
      },
    },
    required: ["summary", "scenarios"],
  },
};

const BASH_TOOL: ToolDef = {
  name: "bash",
  description:
    "Read-only shell in the repo root: cat, ls, find, rg/grep, head, git log. Do NOT modify files.",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

const SYSTEM = `You are Brokk's QA Discovery scout. You map USER JOURNEYS (scenarios), not product gaps.

Explore the checkout with bash, then call submit_scenarios ONCE.

How to explore (efficient — ~12 commands max):
- features.json / app-features.json / config/modules.ts / config/features.ts — enabled modules.
- App routes (app/**/page.tsx, pages/*, src/routes) — real URLs.
- Existing e2e/ and playwright.config — reuse coverage ideas; do not only mirror smoke headings.
- Auth entry (login, demo login) and RBAC hints in roles/capabilities.

Emit scenarios that a GUI agent can execute:
- Always include globals tagged "global": login, logout (if present), and one unauthorized/deep-link gate when relevant.
- For each enabled product module: at least one happy-path scenario; prefer one edge (empty, validation, wrong role).
- ids: stable kebab-case. priority: p0 critical path, p1 important, p2 nice.
- steps/expects: concrete, observable (URL, heading, toast) — not implementation details.
- 8–40 scenarios for a normal app; skip dead/disabled modules.

Rules: read-only. Ground every scenario in files you saw. Call submit_scenarios exactly once.`;

function clip(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…[truncated ${s.length - MAX_OUT} chars]` : s;
}

async function runBash(cwd: string, command: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 60_000,
      maxBuffer: 1024 * 1024 * 16,
      env: shellEnv({ gh: false }),
      signal,
    });
    return clip(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim() || "(no output)");
  } catch (e: any) {
    const out = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`.trim();
    return clip(`exit ${e?.code ?? "?"}\n${out || e?.message || String(e)}`);
  }
}

function coerceScenarios(input: Record<string, unknown>): { summary: string; scenarios: QaScenario[] } {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, 24) : [];
  const pri = (v: unknown): QaScenarioPriority =>
    v === "p1" || v === "p2" || v === "p0" ? v : "p1";
  const raw = Array.isArray(input.scenarios) ? input.scenarios : [];
  const scenarios: QaScenario[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    let id = str(row.id)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    if (!id) continue;
    if (seen.has(id)) id = `${id}-${scenarios.length + 1}`;
    seen.add(id);
    const steps = list(row.steps);
    const expects = list(row.expects);
    if (!steps.length || !expects.length) continue;
    scenarios.push({
      id,
      title: str(row.title) || id,
      module: str(row.module) || "app",
      priority: pri(row.priority),
      role: str(row.role) || "any",
      tags: list(row.tags).slice(0, 8),
      preconditions: list(row.preconditions).slice(0, 8),
      steps,
      expects,
    });
    if (scenarios.length >= 60) break;
  }
  return { summary: str(input.summary) || "QA scenario catalog", scenarios };
}

/** Scout a checkout and return a QA scenario catalog + fingerprint. */
export async function runQaDiscovery(input: RunQaDiscoveryInput): Promise<QaDiscoveryResult> {
  const { cfg, cwd, repoFullName, signal, onProgress } = input;
  const model = resolveModel(cfg, input.model ?? "haiku");
  const maxRounds = input.maxRounds ?? 18;
  const tools = [BASH_TOOL, SCENARIOS_TOOL];
  const fingerprint = await computeQaFingerprint(cwd);

  const messages: ChatTurnMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Build the QA scenario catalog for ${repoFullName}. Fingerprint of current sources: ${fingerprint}. Explore, then submit_scenarios.`,
        },
      ],
    },
  ];

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) throw new Error("qa discovery aborted");
    onProgress?.(`round ${round}`);

    const result = await streamAssistant(
      cfg,
      { model, system: SYSTEM, messages, tools, maxTokens: 8192 },
      () => {},
      signal,
    );
    messages.push({ role: "assistant", content: result.blocks });

    const toolUses = result.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const submit = toolUses.find((t) => t.name === "submit_scenarios");
    if (submit) {
      onProgress?.("scenarios submitted");
      const { summary, scenarios } = coerceScenarios(submit.input);
      if (scenarios.length === 0) throw new Error("qa discovery returned zero scenarios");
      return { summary, fingerprint, scenarios };
    }

    if (result.stopReason !== "tool_use" || toolUses.length === 0) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: "Keep exploring with bash, then call submit_scenarios." }],
      });
      continue;
    }

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

  if (signal?.aborted) throw new Error("qa discovery aborted");
  onProgress?.("forcing conclusion");
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: "Submit the scenario catalog NOW with submit_scenarios based on what you already saw. No more commands.",
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
      maxTokens: 8192,
      toolChoice: { type: "tool", name: "submit_scenarios" },
    },
    () => {},
    signal,
  );
  const forced = finalResult.blocks.find(
    (b): b is ToolUseBlock => b.type === "tool_use" && b.name === "submit_scenarios",
  );
  if (forced) {
    onProgress?.("scenarios submitted (forced)");
    const { summary, scenarios } = coerceScenarios(forced.input);
    if (scenarios.length === 0) throw new Error("qa discovery returned zero scenarios");
    return { summary, fingerprint, scenarios };
  }
  throw new Error(`qa discovery did not converge within ${maxRounds} rounds`);
}
