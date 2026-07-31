import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/** Low-level process-tree primitives shared by the preview supervisor and the
 *  ProcessSandbox (ADR 0073 §fase 1.5, F1). Extracted verbatim from preview.ts so
 *  a future ContainerSandbox can provide its own RSS/kill without duplicating the
 *  /proc walk. Linux-specific (reads /proc); returns null / no-ops elsewhere. */

/** Sum VmRSS of `rootPid` and its descendants (KiB→MiB). Preview boots
 *  `sh -c` detached, so the real vite/next cost lives in the children. */
export function processTreeRssMb(rootPid: number | undefined): number | null {
  if (!rootPid) return null;
  try {
    const children = new Map<number, number[]>();
    for (const ent of readdirSync("/proc")) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = Number(ent);
      let st = "";
      try {
        st = readFileSync(`/proc/${pid}/status`, "utf8");
      } catch {
        continue;
      }
      const ppid = Number(/PPid:\s+(\d+)/.exec(st)?.[1] ?? NaN);
      if (!Number.isFinite(ppid)) continue;
      const list = children.get(ppid) ?? [];
      list.push(pid);
      children.set(ppid, list);
    }
    const stack = [rootPid];
    const seen = new Set<number>();
    let kb = 0;
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      try {
        const st = readFileSync(`/proc/${pid}/status`, "utf8");
        const m = /VmRSS:\s+(\d+)\s+kB/.exec(st);
        if (m) kb += Number(m[1]);
      } catch {
        continue;
      }
      for (const c of children.get(pid) ?? []) stack.push(c);
    }
    if (kb <= 0) return null;
    return Math.max(1, Math.round(kb / 1024));
  } catch {
    return null;
  }
}

/** Kill the whole process group. Preview boots `sh -c "pnpm exec vite|next…"` —
 *  SIGTERM on the shell alone orphans the real server (vite/next) under PID 1,
 *  which is how the forge filled up with dozens of zombies at 95% RAM. Spawn with
 *  detached:true so the shell is group leader; negative-pid kill reaps the tree. */
export function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
}
