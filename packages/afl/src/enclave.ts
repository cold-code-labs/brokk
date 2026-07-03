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
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

// ── RunscEnclave — the Nível 4 backend (ADR 0010 Fase 1) ──────────────────────
// The gVisor backend: instead of running the command in THIS container, it
// dispatches into a persistent, WARM `--runtime=runsc` container that is dedicated
// to ONE project (connected repo). A container escape must break the gVisor sentry
// (a userspace kernel), not the host kernel — the boundary N1–N3 can't give while
// sharing the host kernel. This is opt-in: the trusted worker (this process) keeps
// the secrets/git/control and drives the enclave from outside; the untrusted code
// runs inside, credential-free and off the fleet network.
//
// Model (ADR 0010): ONE enclave per project, not per session. Boots once (the cold
// `install`), stays warm, reaped by idle. Branches (= sessions) are git worktrees
// created by the WORKER on the host checkout and bind-mounted in — so this class
// only needs `exec`; the worktree/preview lifecycle lives in the session layer.
//
// Requirements: the runsc runtime registered on the Docker host (Midgard `runsc`
// role) + this process able to reach the Docker daemon (socket). Where either is
// missing, callers keep the default LocalEnclave — this backend is never forced.

const DOCKER_BIN = process.env.BROKK_DOCKER_BIN || "docker";

export interface RunscEnclaveOpts {
  /** Stable per-project id — one warm enclave per project. Sanitised into the
   *  container name `brokk-enclave-<project>` and its dedicated network. */
  project: string;
  /** Host path of the project checkout. Bind-mounted into the enclave at the SAME
   *  path so the `cwd` the worker passes to exec resolves identically inside. Must
   *  be host-visible to the Docker daemon (same constraint every bind mount has). */
  checkoutRoot: string;
  /** Enclave image — must carry the project toolchain (node/pnpm/git). Default
   *  overridable via BROKK_ENCLAVE_IMAGE. */
  image?: string;
  /** Per-project bridge network. Default `brokk-enclave-<project>` — a DEDICATED
   *  bridge per project gives BOTH boundaries the ADR wants: Docker's inter-network
   *  isolation walls the enclave off from the fleet's `coolify` net AND from other
   *  projects' enclaves (validated: reaching a fleet container's private IP times
   *  out). */
  network?: string;
  /** Upstream DNS servers for the enclave. Default 1.1.1.1 + 8.8.8.8. Needed because
   *  on a user-defined bridge Docker pins resolv.conf to the embedded resolver at
   *  127.0.0.11, which gVisor's netstack CANNOT reach (Connection refused) — so the
   *  enclave gets a bind-mounted resolv.conf with real upstreams instead. Fleet
   *  names still don't resolve (not in public DNS), so lateral-by-name stays dead. */
  dns?: string[];
  /** Host-visible dir where the generated resolv.conf is written (then bind-mounted
   *  read-only at /etc/resolv.conf). Default = the checkout's parent. Must be a real
   *  host path the Docker daemon can mount — the same host-topology concern the
   *  session layer owns. */
  resolvDir?: string;
}

/** The gVisor (runsc) execution enclave for one project. Implements the same
 *  `ExecEnclave.exec` the agents call, so it drops into `FsToolContext.enclave`
 *  with zero agent changes. Lazily boots + warms its container on first exec. */
export class RunscEnclave implements ExecEnclave {
  private readonly project: string;
  private readonly checkoutRoot: string;
  private readonly image: string;
  private readonly network: string;
  private readonly name: string;
  private readonly dns: string[];
  private readonly resolvPath: string;
  /** Single in-flight start, so concurrent execs don't race to boot the container. */
  private startP: Promise<void> | undefined;

  constructor(opts: RunscEnclaveOpts) {
    this.project = opts.project.replace(/[^a-zA-Z0-9_.-]/g, "-");
    this.checkoutRoot = opts.checkoutRoot;
    this.image = opts.image || process.env.BROKK_ENCLAVE_IMAGE || "node:20";
    this.network = opts.network || `brokk-enclave-${this.project}`;
    this.name = `brokk-enclave-${this.project}`;
    this.dns = opts.dns || (process.env.BROKK_ENCLAVE_DNS || "1.1.1.1,8.8.8.8").split(",").map((s) => s.trim()).filter(Boolean);
    const resolvDir = opts.resolvDir || dirname(this.checkoutRoot);
    this.resolvPath = `${resolvDir}/.brokk-enclave-${this.project}-resolv.conf`;
  }

  private async docker(args: string[], timeoutMs = 120_000): Promise<{ out: string; code: number | string | null }> {
    try {
      const { stdout, stderr } = await execFileAsync(DOCKER_BIN, args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 32,
      });
      return { out: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim(), code: 0 };
    } catch (e: any) {
      const out = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`.trim();
      return { out: out || e?.message || String(e), code: e?.code ?? null };
    }
  }

  /** Idempotent boot + warm. Ensures the dedicated bridge exists, then the enclave
   *  container is running (reuse if up, `start` if stopped, `run` if absent).
   *  Concurrency-guarded: many execs share one boot. */
  async ensureStarted(): Promise<void> {
    return (this.startP ??= (async () => {
      // Dedicated per-project bridge — ignore "already exists".
      await this.docker(["network", "create", this.network], 30_000);
      const running = await this.docker(["inspect", "-f", "{{.State.Running}}", this.name], 15_000);
      if (running.code === 0 && running.out === "true") return;
      if (running.code === 0) {
        // exists but stopped → start it
        const started = await this.docker(["start", this.name], 30_000);
        if (started.code === 0) return;
      }
      // absent (or start failed) → (re)create. Remove any stale husk first.
      await this.docker(["rm", "-f", this.name], 30_000);
      // Real-upstream resolv.conf so DNS works under gVisor (see `dns` doc). Best
      // effort: in the co-located worker this write lands on the host dockerd mounts;
      // if it can't be written the run still tries the pre-existing path.
      try {
        await writeFile(this.resolvPath, `${this.dns.map((n) => `nameserver ${n}`).join("\n")}\n`);
      } catch {
        /* pre-provisioned path, or read-only worker — let the run try the mount */
      }
      // `sleep infinity` keeps the enclave warm; the worker drives it via `exec`.
      // No secret env, no fleet network. --runtime=runsc is the whole point.
      const run = await this.docker(
        [
          "run", "-d",
          "--name", this.name,
          "--runtime=runsc",
          "--network", this.network,
          "--label", `brokk.enclave=${this.project}`,
          "-v", `${this.checkoutRoot}:${this.checkoutRoot}`,
          "-v", `${this.resolvPath}:/etc/resolv.conf:ro`,
          "-w", this.checkoutRoot,
          this.image,
          "sleep", "infinity",
        ],
        120_000,
      );
      if (run.code !== 0) {
        // Boot failed — surface it; the caller decides whether to fall back to Local.
        this.startP = undefined; // let a later exec retry
        throw new Error(`RunscEnclave: failed to start ${this.name}: ${run.out}`);
      }
    })());
  }

  /** Run one command INSIDE the warm gVisor enclave. Credential-free by design —
   *  the enclave never receives gh/infra tokens (the worker commits/pushes outside),
   *  so `opts.gh` is intentionally ignored here (a stronger stance than LocalEnclave:
   *  N1 elevated to a kernel guarantee). Same `{out, code}` contract — never throws
   *  for a non-zero exit. */
  async exec(command: string, cwd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    try {
      await this.ensureStarted();
    } catch (e: any) {
      return { out: `enclave unavailable: ${e?.message ?? String(e)}`, code: null };
    }
    const timeout = Math.min(600_000, Number(opts.timeoutMs ?? 120_000));
    // docker exec returns the command's own exit code; the {out, code} normalisation
    // in this.docker() carries a non-zero exit in `code` without throwing.
    return this.docker(
      ["exec", "-w", cwd, "-e", "NODE_ENV=development", "-e", "GIT_TERMINAL_PROMPT=0", this.name, "/bin/sh", "-c", command],
      timeout,
    );
  }

  /** Tear the enclave down (idle reap / cleanup). Best-effort. */
  async stop(): Promise<void> {
    this.startP = undefined;
    await this.docker(["rm", "-f", this.name], 30_000);
    await this.docker(["network", "rm", this.network], 15_000);
  }
}
