import { spawn, type ChildProcess } from "node:child_process";

import { killTree, processTreeRssMb } from "./process-tree.js";

/**
 * Sandbox — the substrate a preview session runs in (ADR 0073 §fase 1.5, F1/F2).
 *
 * The forge preview supervisor runs each app as a `next dev` process. Migrating
 * to per-session isolation (F2: a gVisor/runsc box driven by the fleet
 * enclave-manager, à la Devin's VM-per-task) means swapping only HOW a session
 * is launched, measured, and killed — the supervisor's orchestration (git
 * checkout, Hauldr, runtime resolution, health, respin) stays put.
 *
 * `spawn()` returns a `SandboxHandle` — NOT a raw ChildProcess — because a remote
 * enclave box is not a local process (no ChildProcess, no local pid, output and
 * exit arrive over a transport). The handle is the transport-agnostic surface the
 * supervisor needs; `ProcessSandbox`/`ProcessHandle` back it with a real local
 * ChildProcess (today's behaviour, verbatim), and a future `BrokeredSandbox`
 * backs it with the enclave-manager over HTTP.
 */
export interface SandboxSpawnOpts {
  /** Executable to launch (e.g. "sh", or "nice" when de-prioritised). */
  file: string;
  /** Args for `file` (e.g. ["-c", cmd]). */
  args: string[];
  /** Working directory the command runs in (the preview worktree). */
  cwd: string;
  /** Fully-resolved environment for the process. */
  env: NodeJS.ProcessEnv;
}

/** A running preview session. Mirrors the slice of ChildProcess the supervisor
 *  actually used, so a remote box can satisfy the same contract. */
export interface SandboxHandle {
  /** Process id when the session is a local process; null for a remote box. */
  readonly pid: number | null;
  /** null while running; the exit code once exited (mirrors ChildProcess.exitCode). */
  readonly exitCode: number | null;
  /** true once kill() has been issued (mirrors ChildProcess.killed). */
  readonly killed: boolean;
  /** Attach a listener for each stdout/stderr chunk (already decoded to string). */
  onOutput(listener: (chunk: string, stream: "stdout" | "stderr") => void): void;
  /** Attach a listener for session exit. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** Resident memory (MB) of the session's whole process tree, or null. */
  rssMb(): number | null;
  /** Terminate the session — its whole process tree, not just the shell. */
  kill(): void;
}

export interface Sandbox {
  /** Discriminator for logs/metrics ("process", later "brokk-enclave"). */
  readonly kind: string;
  /** Launch the long-lived dev server for a session and return its handle. */
  spawn(opts: SandboxSpawnOpts): SandboxHandle;
}

/** Handle backed by a local detached process group. */
export class ProcessHandle implements SandboxHandle {
  constructor(private readonly proc: ChildProcess) {}

  get pid(): number | null {
    return this.proc.pid ?? null;
  }
  get exitCode(): number | null {
    return this.proc.exitCode;
  }
  get killed(): boolean {
    return this.proc.killed;
  }
  onOutput(listener: (chunk: string, stream: "stdout" | "stderr") => void): void {
    this.proc.stdout?.on("data", (d: Buffer) => listener(d.toString(), "stdout"));
    this.proc.stderr?.on("data", (d: Buffer) => listener(d.toString(), "stderr"));
  }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.proc.on("exit", (code, signal) => listener(code, signal));
  }
  rssMb(): number | null {
    return processTreeRssMb(this.proc.pid);
  }
  kill(): void {
    killTree(this.proc);
  }
}

/** Current substrate: a bare detached process group on the shared runner host.
 *  No isolation beyond the F0 guardrails — that arrives with the enclave sandbox. */
export class ProcessSandbox implements Sandbox {
  readonly kind = "process";

  spawn({ file, args, cwd, env }: SandboxSpawnOpts): SandboxHandle {
    return new ProcessHandle(
      spawn(file, args, {
        cwd,
        env,
        // Own process group so kill() (negative-pid) reaps pnpm/vite/next children.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  }
}
