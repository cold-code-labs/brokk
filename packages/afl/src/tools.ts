// ─────────────────────────────────────────────────────────────────────────────
// The shared hands — the generic tool layer every Brokk agent forges with. These
// tools operate on a working checkout (`cwd`) and nothing else: precise file ops
// plus a bash workhorse (grep/find, git, gh, package managers, tests, builds).
// They are dependency-pure — no @brokk/db, no cards, no personas — so the kernel
// stays lean. Agents that need DOMAIN tools (create_card, plan_work, submit_brief,
// …) define those themselves and compose them on top via `composeExecutors`.
//
// Trust model (two layers, defence in depth):
//   • env hygiene — `shellEnv` allowlists what reaches the shell so infra secrets
//     never leak to a (possibly prompt-injected) command (Nível 1).
//   • filesystem jail — `sandboxBinPath` runs bash inside a Landlock ruleset so the
//     shell can touch only its own checkout + caches, not sibling sessions, the
//     on-disk gh/npm credentials, or the rest of $HOME (Nível 2, best-effort).
// See docs/NORTH-STAR.md §5, §9 and the brokk-isolation memory.
// ─────────────────────────────────────────────────────────────────────────────

import { exec, execFile } from "node:child_process";
import { promises as fs, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { PartialExecutor, ToolDef } from "./types.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** Where the generic tools operate. */
export interface FsToolContext {
  /** The working checkout the tools operate in. */
  cwd: string;
  /** Whether the bash hand carries GitHub creds (so the agent can commit + open
   *  PRs). Default true (the forge needs it). Read-only consumers (e.g. the
   *  reviewer) pass false to keep gh tokens out of a no-push agent's shell. */
  gh?: boolean;
}

const MAX_OUT = 60_000; // cap tool output handed back to the model

// ── bash env hygiene (isolation Nível 1) ──────────────────────────────────────
// The bash subprocess must NOT inherit Brokk's infra secrets (gateway vkey, DB
// URL, runner/api secrets, model/Langfuse keys…). A prompt-injected `env | grep
// TOKEN` should find nothing useful. We ALLOWLIST (robust) rather than denylist
// (fragile — a new secret env var would leak by default). Only what a shell +
// git + gh legitimately need passes through; gh/git creds are the ONE deliberate
// exception (callers commit + open PRs through them) and are opt-in per caller.
const ENV_ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TZ", "LANG", "LANGUAGE", "PWD",
]);
const ENV_ALLOW_PREFIX = ["LC_", "GIT_AUTHOR_", "GIT_COMMITTER_"];
const GH_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"];

/** Curated env for a bash subprocess: allowlisted vars only. `gh: true` adds the
 *  GitHub creds so `gh`/`git push` work; read-only callers omit it. */
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

// ── bash FS sandbox (isolation Nível 2) ───────────────────────────────────────
// A Landlock jail around the bash hand: the shell may touch ONLY the session's own
// checkout (RW), the package-manager caches a build legitimately writes (RW), and a
// read-only system toolchain. EVERY other path — sibling sessions' checkouts,
// ~/.config/gh & ~/.npmrc credentials (the FS copies of what shellEnv strips from
// the env), the rest of $HOME, host files — is denied by the KERNEL, not by
// convention. Where shellEnv (Nível 1) closes the env-leak, this closes the
// filesystem-leak; the two are layers, not alternatives.
//
// Landlock (not bubblewrap): this host blocks nested unprivileged user namespaces
// (Ubuntu 24.04 apparmor_restrict_unprivileged_userns), so bwrap can't run without
// granting the container CAP_SYS_ADMIN + seccomp/apparmor=unconfined — weakening the
// OUTER boundary to build an inner one. Landlock needs no privilege, no userns, no
// caps: the process restricts ITSELF before exec. Reading another process's environ
// (the node worker's infra secrets) is separately blocked by Yama ptrace_scope=1.
// See tools/brokk-sandbox/main.go and the brokk-isolation memory.
//
// Best-effort: no binary (local/dev) or an unsupported kernel ⇒ run unsandboxed.
// Security tightens where the platform allows; availability is never sacrificed.
// Set BROKK_SANDBOX=0 to force off.

const SANDBOX_BIN = "brokk-sandbox";

/** Absolute path of the sandbox binary on PATH, or null when absent / disabled.
 *  Resolved once at load: containers ship it in /usr/local/bin, dev machines don't. */
const sandboxBinPath: string | null = (() => {
  const flag = process.env.BROKK_SANDBOX;
  if (flag === "0" || flag === "off") return null;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      const p = `${dir}/${SANDBOX_BIN}`;
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here — keep looking */
    }
  }
  return null;
})();

/** The Landlock ruleset for a checkout, expressed as brokk-sandbox flags.
 *  RW = the checkout + the caches npm/pnpm/yarn/bun + the reviewer's scanners write;
 *  RO = the system toolchain + the two credential files a build reads; ~/.config/gh
 *  is granted only when the caller pushes (gh) — a read-only consumer (reviewer,
 *  discovery) can't read the GitHub token off disk. gitCommonDir is a worktree's
 *  shared git dir, which lives OUTSIDE the checkout (forge/reviewer use worktrees) —
 *  granted RW so commit/log/push work; omitted for chat's self-contained clones. */
function sandboxArgs(cwd: string, gh: boolean, gitCommonDir?: string): string[] {
  const home = process.env.HOME || "/home/brokk";
  // /proc & /sys read-only: build tools read them for cpu/mem sizing (os.cpus,
  // cgroup limits). Reading another process's environ is separately blocked by Yama
  // ptrace_scope=1, so granting /proc does NOT re-expose the node worker's secrets.
  const ro = ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc", "/opt", "/proc", "/sys", "/run"];
  const rw = [
    "/dev",
    "/tmp",
    cwd,
    `${home}/.npm`,
    `${home}/.cache`,
    `${home}/.local`,
    `${home}/.config/pnpm`,
    `${home}/.yarn`,
    `${home}/.bun`,
    `${home}/.semgrep`,
  ];
  const roFile = [`${home}/.npmrc`, `${home}/.gitconfig`];
  if (gh) rw.push(`${home}/.config/gh`);
  if (gitCommonDir && !gitCommonDir.startsWith(cwd)) rw.push(gitCommonDir);
  const args: string[] = [];
  for (const d of ro) args.push("--ro", d);
  for (const d of rw) args.push("--rw", d);
  for (const f of roFile) args.push("--ro-file", f);
  return args;
}

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
          const timeout = Math.min(600_000, Number(input.timeout_ms ?? 120_000));
          try {
            const command = String(input.command);
            // Allowlisted env only — no infra secrets reach the shell. gh creds
            // included only when the consumer opts in (forge pushes; reviewer
            // doesn't).
            const opts = { cwd: root, timeout, maxBuffer: 1024 * 1024 * 32, env: shellEnv({ gh }) };
            // When the Landlock jail is available, run the command THROUGH it so the
            // shell can touch only the granted paths; otherwise fall back to a bare
            // shell (dev/local, or a kernel without Landlock). Same stdout/stderr/exit
            // shape either way, so the catch below handles both.
            const { stdout, stderr } = sandboxBinPath
              ? await execFileAsync(
                  sandboxBinPath,
                  [...sandboxArgs(root, gh, await gitCommonDir()), "--", "/bin/sh", "-c", command],
                  opts,
                )
              : await execAsync(command, opts);
            return { ok: true, content: clip(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim() || "(no output)") };
          } catch (e: any) {
            const out = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`.trim();
            return {
              ok: false,
              content: clip(`exit ${e?.code ?? "?"}\n${out || e?.message || String(e)}`),
            };
          }
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
