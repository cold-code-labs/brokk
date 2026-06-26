/**
 * The trusted, in-code mirror of docs/runtime/runtime-providers.json — the
 * package manager table and the per-framework command presets the fast-path
 * emits. Kept here (not imported from docs/) because this is the *trusted* copy
 * the validator/resolver run on; the JSON in docs/ is the knowledge base the
 * Huginn skill (an LLM) reasons over. The two must stay in sync — v1 has only
 * Next.js supported; adding a stack = one entry in both.
 */

export type PmId = "pnpm" | "npm" | "yarn" | "bun";

export interface PmInfo {
  /** Lockfile that proves this package manager. */
  lockfile: string;
  /** `node_modules/.bin` runner — fills the {exec} slot of a command preset. */
  exec: string;
  /** Install command. */
  install: string;
}

/** Order matters: first lockfile present wins; pnpm is the fleet default. */
export const PACKAGE_MANAGERS: Record<PmId, PmInfo> = {
  pnpm: {
    lockfile: "pnpm-lock.yaml",
    exec: "pnpm exec",
    // --prod=false so devDependencies (next, the build toolchain) are installed
    // even when NODE_ENV=production; --no-frozen-lockfile tolerates a drifted lock
    // in a throwaway preview.
    install: "pnpm install --no-frozen-lockfile --prod=false",
  },
  npm: { lockfile: "package-lock.json", exec: "npx", install: "npm install" },
  yarn: { lockfile: "yarn.lock", exec: "yarn", install: "yarn install" },
  bun: { lockfile: "bun.lockb", exec: "bunx", install: "bun install" },
};

export const PM_ORDER: readonly PmId[] = ["pnpm", "npm", "yarn", "bun"] as const;

/** A framework preset: how to detect it + the command templates ({exec} filled
 *  from the detected package manager). `supported:false` presets are recognised
 *  and explained but resolve to `unsupported` until promoted. */
export interface Provider {
  id: string;
  label: string;
  supported: boolean;
  detect: {
    /** package.json dependency/devDependency names that claim this framework. */
    anyDep?: string[];
    /** Config files (relative to appRoot) that claim it. */
    anyFile?: string[];
    /** A `scripts.*` value matching this regex claims it. */
    anyScriptMatches?: string;
  };
  /** Command templates with a `{exec}` placeholder; null for unsupported stacks. */
  commands?: { dev: string; build: string; start: string };
  health?: string;
}

export const PROVIDERS: Provider[] = [
  {
    id: "nextjs",
    label: "Next.js",
    supported: true,
    detect: {
      anyDep: ["next"],
      anyFile: ["next.config.js", "next.config.mjs", "next.config.ts"],
      anyScriptMatches: "next (dev|build|start)",
    },
    commands: {
      dev: "{exec} next dev -p $PORT -H 0.0.0.0",
      build: "{exec} next build",
      start: "{exec} next start -p $PORT -H 0.0.0.0",
    },
    health: "/",
  },
  // Promoted to first-class in v2 (docs/RUNTIME.md). Vite's dev server binds with
  // --host; `vite preview` serves the built dist for the Fleet `build` preview.
  {
    id: "vite",
    label: "Vite",
    supported: true,
    detect: {
      anyDep: ["vite"],
      anyFile: ["vite.config.js", "vite.config.ts", "vite.config.mjs"],
      anyScriptMatches: "vite( build| preview)?",
    },
    commands: {
      dev: "{exec} vite --port $PORT --host 0.0.0.0",
      build: "{exec} vite build",
      start: "{exec} vite preview --port $PORT --host 0.0.0.0",
    },
    health: "/",
  },
  {
    id: "astro",
    label: "Astro",
    supported: true,
    detect: {
      anyDep: ["astro"],
      anyFile: ["astro.config.mjs", "astro.config.ts"],
      anyScriptMatches: "astro (dev|build|preview)",
    },
    commands: {
      dev: "{exec} astro dev --port $PORT --host 0.0.0.0",
      build: "{exec} astro build",
      start: "{exec} astro preview --port $PORT --host 0.0.0.0",
    },
    health: "/",
  },
];
