// ─────────────────────────────────────────────────────────────────────────────
// The execution enclave — the single chokepoint every Brokk agent's bash runs
// through. Today it's `LocalEnclave`: the command executes in this container,
// wrapped in the Landlock jail (Nível 2) + egress uid-split (Nível 3) with an
// allowlisted env (Nível 1). Tomorrow a `RunscEnclave` plugs in behind the SAME
// interface and the agents don't change — the seam is the whole point.
//
// This is Fase 0 of ADR 0010 (Brokk execution enclave, gVisor). The ADR's model
// is ONE persistent, warm gVisor sandbox PER PROJECT (connected repo); the trusted
// worker stays OUTSIDE with the secrets/git/control and drives the enclave from
// afar. Fase 0 extracts only the bash chokepoint (`ExecEnclave.exec`) with a
// `local` backend behaving identically to today; the lifecycle methods that own
// the warm sandbox + worktrees + preview (ensureStarted / ensureBranch /
// previewUrl) land in Fase 1 with RunscEnclave, driven by the session layer — not
// the tool executor. See docs/decisoes/0010 (Edda) and the brokk-isolation memory.
// ─────────────────────────────────────────────────────────────────────────────

import { exec, execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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

/** The egress uid/gid the sandbox drops the bash hand to (isolation Nível 3). A uid
 *  distinct from the node worker's (1001) is the discriminator the container's nft
 *  ruleset keys on to firewall the shell off the fleet's internal subnets. The
 *  drop is best-effort: only takes effect where brokk-sandbox ships setuid to this
 *  uid (the containers); a bare binary (dev/local) warns and runs as-is. Set
 *  BROKK_BASH_UID=0 (or empty) to disable passing the flags entirely. gid defaults
 *  to the worker's gid so the shell shares the group and can write the checkout. */
const bashUid: number | null = (() => {
  const raw = process.env.BROKK_BASH_UID;
  if (raw === "" || raw === "0") return null;
  const n = Number(raw ?? 1002);
  return Number.isInteger(n) && n > 0 ? n : 1002;
})();
const bashGid = Number(process.env.BROKK_BASH_GID ?? 1001);

/** The Landlock ruleset for a checkout, expressed as brokk-sandbox flags.
 *  RW = the checkout + the caches npm/pnpm/yarn/bun + the reviewer's scanners write;
 *  RO = the system toolchain + the two credential files a build reads; ~/.config/gh
 *  is granted only when the caller pushes (gh) — a read-only consumer (reviewer,
 *  discovery) can't read the GitHub token off disk. gitCommonDir is a worktree's
 *  shared git dir, which lives OUTSIDE the checkout (forge/reviewer use worktrees) —
 *  granted RW so commit/log/push work; omitted for chat's self-contained clones.
 *  --uid/--gid make the shell drop to the egress uid before Landlock + exec. */
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
  if (bashUid !== null) args.push("--uid", String(bashUid), "--gid", String(bashGid));
  for (const d of ro) args.push("--ro", d);
  for (const d of rw) args.push("--rw", d);
  for (const f of roFile) args.push("--ro-file", f);
  return args;
}

/** Per-command execution context handed to the enclave. */
export interface ExecOpts {
  /** Whether the shell carries GitHub creds (commit + PR). Default true; read-only
   *  callers (reviewer, discovery) pass false to keep gh tokens out of the shell. */
  gh?: boolean;
  /** Wall-clock cap in ms; clamped to 600_000. Default 120_000. */
  timeoutMs?: number;
  /** A git worktree's shared common dir (outside cwd), granted RW in the FS jail so
   *  git writes don't EACCES. Undefined for self-contained clones (no worktree). */
  gitCommonDir?: string;
}

/** The result of one command: combined output + exit code. `exec` never throws for
 *  a non-zero exit — the failure is carried in `code` (0 = success; a number, a
 *  spawn errno string, or null for a timeout otherwise). */
export interface ExecResult {
  out: string;
  code: number | string | null;
}

/** Where the agents' bash runs. Fase 0 of ADR 0010: only `exec` exists (the tool
 *  chokepoint). Fase 1 (RunscEnclave) adds the warm-sandbox lifecycle — ensureStarted
 *  / ensureBranch(branch) → worktree / previewUrl(branch) — driven by the session
 *  layer, and swaps in behind this interface without the agents noticing. */
export interface ExecEnclave {
  exec(command: string, cwd: string, opts?: ExecOpts): Promise<ExecResult>;
}

/** The default backend: run the command in THIS container, wrapped in the Landlock
 *  jail + egress uid-split when the sandbox binary is present, with an allowlisted
 *  env. Behaviourally identical to the inline bash executor it was extracted from. */
export class LocalEnclave implements ExecEnclave {
  async exec(command: string, cwd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const gh = opts.gh ?? true;
    const timeout = Math.min(600_000, Number(opts.timeoutMs ?? 120_000));
    // Allowlisted env only — no infra secrets reach the shell. gh creds included
    // only when the consumer opts in (forge pushes; reviewer doesn't).
    const execOpts = { cwd, timeout, maxBuffer: 1024 * 1024 * 32, env: shellEnv({ gh }) };
    try {
      // When the Landlock jail is available, run the command THROUGH it so the shell
      // can touch only the granted paths; otherwise fall back to a bare shell
      // (dev/local, or a kernel without Landlock). Same stdout/stderr shape either way.
      const { stdout, stderr } = sandboxBinPath
        ? await execFileAsync(
            sandboxBinPath,
            [...sandboxArgs(cwd, gh, opts.gitCommonDir), "--", "/bin/sh", "-c", command],
            execOpts,
          )
        : await execAsync(command, execOpts);
      return { out: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim(), code: 0 };
    } catch (e: any) {
      const out = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`.trim();
      return { out: out || e?.message || String(e), code: e?.code ?? null };
    }
  }
}

/** The process-wide default enclave. `makeFsExecutor` uses it unless a caller injects
 *  its own (the plug point for RunscEnclave in Fase 1). */
export const localEnclave: ExecEnclave = new LocalEnclave();
