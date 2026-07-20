/**
 * Next 16's default `next dev` (Turbopack) needs the **native** SWC binding for
 * the host libc. Preview worktrees often only have `@next/swc-linux-x64-musl`
 * (lockfile from Alpine / wrong supportedArchitectures) while the forge runs
 * Debian glibc — Next then falls back to WASM and Turbopack refuses to start.
 *
 * Shared core: warm tarballs live in `/opt/brokk/next-swc` (image); on boot we
 * ensure `@next/swc-linux-x64-gnu` matching the app's `next` version is
 * resolvable from the worktree before spawning `next dev`.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PACKAGE_MANAGERS, PM_ORDER, type PmId } from "@brokk/core/runtime";

const execFileAsync = promisify(execFile);

/** Image-baked cache of unpacked `@next/swc-linux-x64-gnu` tarballs, keyed by version. */
export const NEXT_SWC_CACHE_DIR = "/opt/brokk/next-swc";

const GNU = "@next/swc-linux-x64-gnu";

export type EnsureSwcResult =
  | { status: "skipped"; reason: string }
  | { status: "ok"; version: string; via: "already" | "cache" | "install" };

/** True when this appDir looks like a Next app with node_modules present. */
export function nextVersionAt(appDir: string): string | null {
  const pkgPath = join(appDir, "node_modules", "next", "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const v = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version;
    return v && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Can Node resolve + load the gnu binding from this app's next install? */
export function gnuSwcLoadable(appDir: string): boolean {
  try {
    const req = createRequire(join(appDir, "package.json"));
    const nextPkg = req.resolve("next/package.json");
    const nextReq = createRequire(nextPkg);
    // Prefer resolving as next would (from next's tree), then from the app root.
    let binding: string;
    try {
      binding = nextReq.resolve(GNU);
    } catch {
      binding = req.resolve(GNU);
    }
    // Loading the .node proves glibc + arch match (resolve alone is not enough).
    nextReq(binding);
    return true;
  } catch {
    return false;
  }
}

function detectPm(appDir: string): PmId {
  for (const id of PM_ORDER) {
    if (existsSync(join(appDir, PACKAGE_MANAGERS[id].lockfile))) return id;
  }
  return "pnpm";
}

/** Symlink a cached unpack where Next's resolver will find it (app root + next's node_modules). */
function linkFromCache(appDir: string, version: string): boolean {
  const cached = join(NEXT_SWC_CACHE_DIR, version);
  if (!existsSync(join(cached, "package.json"))) return false;

  const targets: string[] = [join(appDir, "node_modules", "@next", "swc-linux-x64-gnu")];
  try {
    const req = createRequire(join(appDir, "package.json"));
    const nextPkg = req.resolve("next/package.json");
    // …/node_modules/next/package.json → …/node_modules/@next/swc-linux-x64-gnu
    targets.push(join(nextPkg, "..", "..", "@next", "swc-linux-x64-gnu"));
  } catch {
    /* next not resolvable yet */
  }

  for (const dest of targets) {
    try {
      mkdirSync(join(dest, ".."), { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      symlinkSync(cached, dest);
    } catch {
      /* try next target */
    }
  }
  return gnuSwcLoadable(appDir);
}

async function installGnu(appDir: string, version: string, env: NodeJS.ProcessEnv): Promise<void> {
  const pm = detectPm(appDir);
  const spec = `${GNU}@${version}`;
  const cmd =
    pm === "pnpm"
      ? ["pnpm", ["add", "-D", spec]]
      : pm === "yarn"
        ? ["yarn", ["add", "-D", spec]]
        : pm === "bun"
          ? ["bun", ["add", "-d", spec]]
          : ["npm", ["install", "--save-dev", spec]];
  await execFileAsync(cmd[0] as string, cmd[1] as string[], {
    cwd: appDir,
    env,
    timeout: 120_000,
  });
}

/**
 * Ensure Turbopack can load native SWC on this glibc forge. No-op when next is
 * absent or gnu already loads. Prefer image cache, else package-manager install
 * (hits the shared pnpm store after the first version).
 */
export async function ensureNativeNextSwc(
  appDir: string,
  env: NodeJS.ProcessEnv,
): Promise<EnsureSwcResult> {
  const version = nextVersionAt(appDir);
  if (!version) return { status: "skipped", reason: "next not installed yet" };

  if (gnuSwcLoadable(appDir)) {
    return { status: "ok", version, via: "already" };
  }

  if (linkFromCache(appDir, version) || gnuSwcLoadable(appDir)) {
    return { status: "ok", version, via: "cache" };
  }

  await installGnu(appDir, version, env);
  if (!gnuSwcLoadable(appDir)) {
    throw new Error(
      `${GNU}@${version} installed but still not loadable (glibc/arch mismatch?)`,
    );
  }
  return { status: "ok", version, via: "install" };
}
