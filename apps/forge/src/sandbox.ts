import { spawn, type ChildProcess } from "node:child_process";

import { killTree, processTreeRssMb } from "./process-tree.js";

/**
 * Sandbox — the substrate a preview session runs in (ADR 0073 §fase 1.5, F1).
 *
 * The forge preview supervisor runs each app as a `next dev` process on a SHARED
 * host. Migrating to per-session isolation (F2 ContainerSandbox, à la Devin's
 * VM-per-task) means swapping only HOW a session is launched, measured, and
 * killed — the supervisor's orchestration (git checkout, Hauldr, runtime
 * resolution, health, respin) stays put. This interface is that seam: the three
 * primitives that differ between a bare process and a container.
 *
 * `ProcessSandbox` is today's behaviour, extracted verbatim: a detached `sh -c`
 * process group, the /proc RSS tree, and a negative-pid group kill. A future
 * `ContainerSandbox` implements the same contract over `docker run`/`stats`/`rm`
 * — and gets dropped into `PreviewSupervisor` in one line.
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

export interface Sandbox {
  /** Discriminator for logs/metrics ("process", later "container"). */
  readonly kind: string;
  /** Launch the long-lived dev server for a session. The returned process MUST be
   *  its own group leader so `kill` can reap the whole tree (shell + vite/next). */
  spawn(opts: SandboxSpawnOpts): ChildProcess;
  /** Resident memory (MB) of the session's whole process tree, or null. */
  rssMb(proc: ChildProcess): number | null;
  /** Terminate the session — its whole process tree, not just the shell. */
  kill(proc: ChildProcess): void;
}

/** Current substrate: a bare detached process group on the shared runner host.
 *  No isolation beyond the F0 guardrails — that arrives with ContainerSandbox. */
export class ProcessSandbox implements Sandbox {
  readonly kind = "process";

  spawn({ file, args, cwd, env }: SandboxSpawnOpts): ChildProcess {
    return spawn(file, args, {
      cwd,
      env,
      // Own process group so kill() (negative-pid) reaps pnpm/vite/next children.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  rssMb(proc: ChildProcess): number | null {
    return processTreeRssMb(proc.pid);
  }

  kill(proc: ChildProcess): void {
    killTree(proc);
  }
}
