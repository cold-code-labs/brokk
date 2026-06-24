// ─────────────────────────────────────────────────────────────────────────────
// Sindri's tool layer (Option B — our own tools, not the Agent SDK's). A small,
// powerful set that operates on the session's working checkout (`cwd`):
//
//   read_file / write_file / edit_file / list_dir  — precise file ops
//   bash                                            — the workhorse: grep, find,
//                                                     git, gh, pnpm, tests, …
//   create_card / list_cards / enqueue_card         — Brokk domain bridge: spin
//                                                     work off to the autonomous
//                                                     forge (Brokkr) from a chat
//
// bash gives us git + gh for free, so "commit / open PR / merge" needs no bespoke
// tool. Internal single-tenant tooling → bash runs unsandboxed in the checkout,
// the same trust model as the forge runner's bypassPermissions.
// ─────────────────────────────────────────────────────────────────────────────

import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Store } from "@brokk/db";
import type { ToolDef, ToolExecutor } from "./types.js";

const execAsync = promisify(exec);

export interface ToolContext {
  /** The working checkout the tools operate in. */
  cwd: string;
  /** The Brokk project this session belongs to (for domain tools). */
  projectId: string;
  store: Store;
  /** Default base branch for cards spun off to the forge. */
  baseBranch: string;
  /** Called whenever a domain tool mutates Brokk state, so the host can surface it. */
  onDomainEvent?: (e: { kind: string; detail: unknown }) => void;
  /** Host-provided planner bridge (the `plan_work` tool): decompose an intent via
   *  Mímir into proposed backlog cards. Injected by the Sindri app (which owns the
   *  planner config + gateway); absent in contexts without a planner. */
  planWork?: (intent: string) => Promise<{ ok: boolean; content: string }>;
}

const MAX_OUT = 60_000; // cap tool output handed back to the model

// ── bash env hygiene (isolation Nível 1) ──────────────────────────────────────
// The bash subprocess must NOT inherit Brokk's infra secrets (gateway vkey, DB
// URL, runner/api secrets, model/Langfuse keys…). A prompt-injected `env | grep
// TOKEN` should find nothing useful. We ALLOWLIST (robust) rather than denylist
// (fragile — a new secret env var would leak by default). Only what a shell +
// git + gh legitimately need passes through; gh/git creds are the ONE deliberate
// exception (Sindri commits + opens PRs through them) and are opt-in per caller.
const ENV_ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TZ", "LANG", "LANGUAGE", "PWD",
]);
const ENV_ALLOW_PREFIX = ["LC_", "GIT_AUTHOR_", "GIT_COMMITTER_"];
const GH_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"];

/** Curated env for a bash subprocess: allowlisted vars only. `gh: true` adds the
 *  GitHub creds so `gh`/`git push` work (Sindri); read-only callers omit it. */
export function shellEnv(opts?: { gh?: boolean; extra?: Record<string, string> }): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALLOW.has(k) || ENV_ALLOW_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  if (opts?.gh) for (const k of GH_KEYS) if (process.env[k]) out[k] = process.env[k];
  out.NODE_ENV = "development";
  out.GIT_TERMINAL_PROMPT = "0";
  return { ...out, ...opts?.extra };
}

/** Resolve a model-supplied path within the checkout; reject escapes (`..`). */
function safePath(root: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the project root: ${p}`);
  }
  return abs;
}

function clip(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…[truncated ${s.length - MAX_OUT} chars]` : s;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the project. Optionally a line range via offset (1-based) and limit.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root." },
        offset: { type: "integer", description: "First line to read (1-based)." },
        limit: { type: "integer", description: "Max number of lines to read." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file. Creates parent directories as needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact substring in a file. old_string must match uniquely unless replace_all is true.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_dir",
    description: "List entries of a directory in the project (dirs marked with a trailing /).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Default: project root." } },
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command in the project root. Use for search (grep/find/rg), git, gh (PRs), package managers, tests, builds. Returns combined stdout+stderr and the exit code.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer", description: "Default 120000, max 600000." },
      },
      required: ["command"],
    },
  },
  {
    name: "create_card",
    description:
      "Create a Brokk card (task) in this project's backlog. Use to capture follow-up work or to hand a well-scoped task to the autonomous forge.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        enqueue: {
          type: "boolean",
          description: "If true, queue it immediately so Brokkr forges it to a PR.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "list_cards",
    description: "List this project's Brokk cards, optionally filtered by status.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "backlog | queued | running | review | done | failed | cancelled",
        },
      },
    },
  },
  {
    name: "plan_work",
    description:
      "Decompose a LARGER, multi-part request into an ordered set of well-scoped work cards using Mímir (the strong planner), and drop them into this project's backlog as PROPOSED cards for human approval. Use this when the user asks for something substantial — spanning multiple files, layers, or features — instead of a single small change (for a small change, use create_card). The cards do NOT execute until a human approves them. If the request is ambiguous, the planner may return clarifying questions for you to relay to the user.",
    input_schema: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: "The full request to plan, in the user's own words and language.",
        },
      },
      required: ["intent"],
    },
  },
];

/** Build the executor bound to one session's checkout + project. */
export function makeExecutor(ctx: ToolContext): ToolExecutor {
  const root = ctx.cwd;
  return async (name, input) => {
    try {
      switch (name) {
        case "read_file": {
          const p = safePath(root, String(input.path));
          let text = await fs.readFile(p, "utf8");
          if (input.offset || input.limit) {
            const lines = text.split("\n");
            const start = Math.max(0, Number(input.offset ?? 1) - 1);
            const end = input.limit ? start + Number(input.limit) : lines.length;
            text = lines.slice(start, end).join("\n");
          }
          return { ok: true, content: clip(text) || "(empty file)" };
        }
        case "write_file": {
          const p = safePath(root, String(input.path));
          await fs.mkdir(dirname(p), { recursive: true });
          await fs.writeFile(p, String(input.content ?? ""), "utf8");
          return { ok: true, content: `wrote ${input.path}` };
        }
        case "edit_file": {
          const p = safePath(root, String(input.path));
          const old = String(input.old_string ?? "");
          const next = String(input.new_string ?? "");
          const cur = await fs.readFile(p, "utf8");
          if (!cur.includes(old)) return { ok: false, content: `old_string not found in ${input.path}` };
          const count = cur.split(old).length - 1;
          if (count > 1 && !input.replace_all)
            return { ok: false, content: `old_string is not unique (${count} matches); set replace_all or add context` };
          const updated = input.replace_all ? cur.split(old).join(next) : cur.replace(old, next);
          await fs.writeFile(p, updated, "utf8");
          return { ok: true, content: `edited ${input.path} (${input.replace_all ? count : 1} replacement(s))` };
        }
        case "list_dir": {
          const p = input.path ? safePath(root, String(input.path)) : root;
          const entries = await fs.readdir(p, { withFileTypes: true });
          const out = entries
            .filter((e) => e.name !== ".git")
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort()
            .join("\n");
          return { ok: true, content: clip(out) || "(empty)" };
        }
        case "bash": {
          const timeout = Math.min(600_000, Number(input.timeout_ms ?? 120_000));
          try {
            const { stdout, stderr } = await execAsync(String(input.command), {
              cwd: root,
              timeout,
              maxBuffer: 1024 * 1024 * 32,
              // Allowlisted env only — no infra secrets reach the shell. gh creds
              // kept so the chat can commit + open PRs.
              env: shellEnv({ gh: true }),
            });
            return { ok: true, content: clip(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim() || "(no output)") };
          } catch (e: any) {
            const out = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`.trim();
            return {
              ok: false,
              content: clip(`exit ${e?.code ?? "?"}\n${out || e?.message || String(e)}`),
            };
          }
        }
        case "create_card": {
          const task = await ctx.store.insertTask({
            projectId: ctx.projectId,
            title: String(input.title),
            body: String(input.body ?? ""),
            status: input.enqueue ? "queued" : "backlog",
            baseBranch: ctx.baseBranch,
            createdBy: "sindri",
          });
          ctx.onDomainEvent?.({ kind: "card_created", detail: { id: task.id, enqueued: !!input.enqueue } });
          return {
            ok: true,
            content: `created card ${task.id} "${task.title}" (${task.status})`,
          };
        }
        case "list_cards": {
          const status = input.status ? (String(input.status) as never) : undefined;
          const cards = await ctx.store.listTasks({ projectId: ctx.projectId, status });
          if (!cards.length) return { ok: true, content: "(no cards)" };
          const out = cards
            .slice(0, 50)
            .map((c) => `- [${c.status}] ${c.title} (${c.id.slice(0, 8)})${c.prUrl ? ` → ${c.prUrl}` : ""}`)
            .join("\n");
          return { ok: true, content: out };
        }
        case "plan_work": {
          if (!ctx.planWork) return { ok: false, content: "planning is not available in this context" };
          const intent = String(input.intent ?? "").trim();
          if (!intent) return { ok: false, content: "plan_work needs an intent" };
          return await ctx.planWork(intent);
        }
        default:
          return { ok: false, content: `unknown tool: ${name}` };
      }
    } catch (e) {
      return { ok: false, content: `tool ${name} failed: ${(e as Error).message}` };
    }
  };
}
