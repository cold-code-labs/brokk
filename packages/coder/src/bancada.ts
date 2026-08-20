import type { RuntimeSpec } from "@brokk/core";
import type { RichParameter } from "./types.js";

/** The recipe a bancada is built from. Everything here comes from the control
 *  plane (project + repository + pinned RuntimeSpec) — nothing is guessed at
 *  provisioning time, and nothing is read off the workspace's own disk. */
export interface BancadaRecipe {
  /** `owner/name` of the GitHub repository. */
  repo: string;
  /** Branch the bancada checks out and pushes from. */
  branch: string;
  /** Pinned runtime. A project without one cannot get a bancada — see below. */
  runtime: RuntimeSpec;
  /** Extra env materialised as `.env.local` in the app root (the dev BaaS keys,
   *  typically). Values are injected by the control plane, never by the repo. */
  env?: Record<string, string>;
}

/** Coder rejects names outside this shape, and truncating blindly collides
 *  (`contorna-ai-lp` and `contorna-ai-labs` share a prefix). Slug + short digest
 *  keeps it deterministic *and* unique. */
const MAX_NAME = 32;

export function workspaceName(project: string, lane: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const full = `${slug(project)}-${slug(lane)}`;
  if (full.length <= MAX_NAME) return full;
  const digest = fnv1a(full).toString(36).slice(0, 6);
  // Trim the cut back off a hyphen — `…page-` + `-hash` would produce the double
  // hyphen Coder rejects.
  const head = full.slice(0, MAX_NAME - digest.length - 1).replace(/-+$/, "");
  return `${head}-${digest}`;
}

/** Non-cryptographic, stable across processes (a hash used for a *name* must not
 *  move between deploys, which rules out Node's seeded string hashing). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Conventional dev port per runtime family. The port is not cosmetic: it is
 *  baked into the workspace app's healthcheck, so it must be decided here — by
 *  the control plane — and not sniffed inside the container. */
export function devPort(runtime: RuntimeSpec): number {
  switch (runtime.id) {
    case "vite":
    case "vite-ssg":
      return 5173;
    case "expo":
      return 8081;
    case "astro":
      return 4321;
    default:
      return 3000;
  }
}

export class UnrunnableProject extends Error {}

/** Turn a recipe into the rich parameters the `bancada` template takes.
 *
 *  Two rules earned the hard way (2026-08-20):
 *
 *  1. **`$PORT` is resolved here.** Coder expands an agent's env as a shell
 *     string, so a `$PORT` left inside `dev` becomes empty *before* the startup
 *     script runs — vite got `--port` with no value and died at boot.
 *  2. **A project with no pinned runtime is refused, loudly.** Guessing the dev
 *     command is how a bancada is born broken and reports itself ready.
 */
export function bancadaParameters(recipe: BancadaRecipe): RichParameter[] {
  const { runtime } = recipe;
  if (!runtime?.dev) {
    throw new UnrunnableProject(
      "project has no pinned runtime.dev — detect the runtime before opening a bancada",
    );
  }
  if (runtime.supported === false) {
    throw new UnrunnableProject(runtime.reason ?? `runtime ${runtime.id} is not supported yet`);
  }
  const port = devPort(runtime);
  const dev = runtime.dev.replaceAll("$PORT", String(port)).replaceAll("${PORT}", String(port));
  return [
    { name: "repo", value: recipe.repo },
    { name: "branch", value: recipe.branch },
    { name: "install_cmd", value: runtime.install || "pnpm install --no-frozen-lockfile" },
    { name: "dev_cmd", value: dev },
    { name: "app_root", value: runtime.appRoot || "." },
    { name: "dev_port", value: String(port) },
    { name: "extra_env", value: JSON.stringify({ ...(runtime.env ?? {}), ...(recipe.env ?? {}) }) },
  ];
}
