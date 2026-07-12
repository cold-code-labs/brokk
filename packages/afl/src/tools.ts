// ─────────────────────────────────────────────────────────────────────────────
// The shared hands — the generic tool layer every Brokk agent forges with. These
// tools operate on a working checkout (`cwd`) and nothing else: precise file ops
// plus a bash workhorse (grep/find, git, gh, package managers, tests, builds).
// They are dependency-pure — no @brokk/db, no cards, no personas — so the kernel
// stays lean. Agents that need DOMAIN tools (create_card, plan_work, submit_brief,
// …) define those themselves and compose them on top via `composeExecutors`.
//
// Trust model: the bash hand runs through the execution enclave (`ExecEnclave`,
// see enclave.ts) — env hygiene (Nível 1) + Landlock FS jail (Nível 2) + egress
// uid-split (Nível 3) live there, behind one interface so a gVisor backend can
// swap in without touching the agents (ADR 0010). This file owns the file ops
// (read/write/edit/list) + routes bash to the enclave.
// See docs/NORTH-STAR.md §5, §9, docs/decisoes/0010 (Edda) and brokk-isolation.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type ExecEnclave, localEnclave } from "./enclave.js";
import type { PartialExecutor, ToolDef } from "./types.js";

const execFileAsync = promisify(execFile);

/** Where the generic tools operate. */
export interface FsToolContext {
  /** The working checkout the tools operate in. */
  cwd: string;
  /** Whether the bash hand carries GitHub creds (so the agent can commit + open
   *  PRs). Default true (the forge needs it). Read-only consumers (e.g. the
   *  reviewer) pass false to keep gh tokens out of a no-push agent's shell. */
  gh?: boolean;
  /** Where bash runs. Default `localEnclave` (this container + Landlock/uid jail).
   *  The plug point for a per-project RunscEnclave (ADR 0010 Fase 1). */
  enclave?: ExecEnclave;
}

const MAX_OUT = 60_000; // cap tool output handed back to the model

/** A git worktree keeps its shared object store / refs in a common dir OUTSIDE the
 *  checkout; the sandbox must grant it or every git write EACCES-es. Best-effort:
 *  a non-git dir (or absent git) resolves to none and the jail just skips it. */
async function resolveGitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
      timeout: 5_000,
    });
    const p = stdout.trim();
    if (!p) return undefined;
    return isAbsolute(p) ? p : resolve(cwd, p);
  } catch {
    return undefined;
  }
}

/** Resolve a model-supplied path within the checkout; reject escapes (`..`). */
export function safePath(root: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the project root: ${p}`);
  }
  return abs;
}

/** Clip oversized tool output to MAX_OUT chars with a truncation marker. */
export function clip(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…[truncated ${s.length - MAX_OUT} chars]` : s;
}

/** The generic file + bash tool definitions handed to the model. */
export const FS_TOOL_DEFS: ToolDef[] = [
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
];

/** The read-only subset of the hands: inspect a checkout without mutating it
 *  (read_file + list_dir + bash for grep/git-log/etc.). The lean tool surface for
 *  reviewers/scouts (§9 #6) — the model can't call write_file/edit_file it isn't
 *  shown. Pair with makeFsExecutor({ gh: false }) to also keep gh creds out. */
export const FS_READONLY_TOOL_DEFS: ToolDef[] = FS_TOOL_DEFS.filter((t) =>
  t.name === "read_file" || t.name === "list_dir" || t.name === "bash",
);

/** A partial executor for the generic file + bash tools, bound to one checkout.
 *  Returns `null` for any tool it does not own, so domain executors compose on
 *  top via `composeExecutors`. */
export function makeFsExecutor(ctx: FsToolContext): PartialExecutor {
  const root = ctx.cwd;
  const gh = ctx.gh ?? true;
  const enclave = ctx.enclave ?? localEnclave;
  // Resolve the worktree's shared git dir once (cwd is fixed per executor) and reuse
  // the promise across bash calls; only matters when the sandbox is active.
  let commonDirP: Promise<string | undefined> | undefined;
  const gitCommonDir = () => (commonDirP ??= resolveGitCommonDir(root));
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
          // Route bash to the execution enclave: it owns the env allowlist + Landlock
          // jail + egress uid-split and normalises the run to {out, code} (never throws
          // for a non-zero exit). Same output shape as the old inline executor.
          const { out, code } = await enclave.exec(String(input.command), root, {
            gh,
            timeoutMs: Number(input.timeout_ms ?? 120_000),
            gitCommonDir: await gitCommonDir(),
          });
          if (code === 0) return { ok: true, content: clip(out || "(no output)") };
          // code === null is the enclave's INFRA-FAULT signal, distinct from a command
          // that ran and exited non-zero (which always carries a numeric code). Every
          // enclave-down shape lands here: RunscEnclave "enclave unavailable: …" (boot/
          // mount failure) AND BrokeredEnclave "enclave manager unreachable/NNN: …"
          // (the sidecar is down or erroring). Don't dress any of them as "exit ?": say
          // plainly the execution environment is DOWN, so the agent stops silently
          // routing around it via file-tools and never implies a change is verified when
          // it could not run a single command. An environment fault to surface to the
          // user, not a task step to work past.
          if (code === null) {
            return {
              ok: false,
              content: clip(
                `EXECUTION ENVIRONMENT UNAVAILABLE — cannot run commands (tests, builds, typecheck, git/gh) in this session.\n${out}\n\n` +
                  `Do NOT keep working as if this succeeded: any file edits cannot be verified or committed. Stop and tell the user their execution environment is down (an infra/enclave fault, not a code problem) instead of presenting changes as ready.`,
              ),
            };
          }
          return { ok: false, content: clip(`exit ${code}\n${out}`) };
        }
        default:
          return null; // not a generic tool — let a domain executor try
      }
    } catch (e) {
      return { ok: false, content: `tool ${name} failed: ${(e as Error).message}` };
    }
  };
}

/** Compose partial executors into one ToolExecutor: each is tried in order; the
 *  first non-null result wins. Falls back to an unknown-tool error. */
export function composeExecutors(...parts: PartialExecutor[]) {
  return async (name: string, input: Record<string, unknown>) => {
    for (const part of parts) {
      const r = await part(name, input);
      if (r) return r;
    }
    return { ok: false, content: `unknown tool: ${name}` };
  };
}
