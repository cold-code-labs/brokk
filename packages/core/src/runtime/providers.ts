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
  /** HTTP path that reveals whether the JS bundle compiles (see RuntimeSpec). */
  bundleProbe?: string;
  /** Extra env for the dev process. `$PUBLIC_URL` expands to the preview's public
   *  URL at boot (supervisor-side), so no framework knowledge leaks into the forge. */
  env?: Record<string, string>;
  /** Files the forge writes into appRoot before boot (see RuntimeSpec.prepareFiles). */
  prepareFiles?: Array<{ path: string; contents: string }>;
}

// Vite 5.4+ rejects any request whose Host header isn't in `server.allowedHosts`
// (403 "This host is not allowed"). Dev-lane previews are served through the
// gateway at <app>-dev.preview.coldcodelabs.com, so every Vite app 403s unless it
// opts that host in — and Vite exposes NO CLI flag or env for it, only config.
// So the forge writes this wrapper into the checkout and points `vite --config`
// at it: it loads the app's OWN config (loadConfigFromFile finds vite.config.* in
// cwd; the wrapper lives under .brokk/ so it never matches itself) and merges in
// the preview host allowlist for both the dev server and `vite preview`. No
// app-repo edit required; the app keeps its plugins/aliases/port untouched.
const VITE_PREVIEW_CONFIG_PATH = ".brokk/vite.preview.config.mjs";
const VITE_PREVIEW_CONFIG = `import { loadConfigFromFile, mergeConfig } from "vite";
const PREVIEW_HOSTS = [".preview.coldcodelabs.com"];
export default async (env) => {
  const loaded = await loadConfigFromFile(env, undefined, process.cwd());
  return mergeConfig(loaded?.config ?? {}, {
    server: { allowedHosts: PREVIEW_HOSTS },
    preview: { allowedHosts: PREVIEW_HOSTS },
  });
};
`;

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
      dev: "{exec} next dev --webpack -p $PORT -H 0.0.0.0",
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
      // `--config=path` (equals form) — space-separated path is not an allowlist token.
      dev: `{exec} vite --port $PORT --host 0.0.0.0 --config=${VITE_PREVIEW_CONFIG_PATH}`,
      build: "{exec} vite build",
      start: `{exec} vite preview --port $PORT --host 0.0.0.0 --config=${VITE_PREVIEW_CONFIG_PATH}`,
    },
    prepareFiles: [{ path: VITE_PREVIEW_CONFIG_PATH, contents: VITE_PREVIEW_CONFIG }],
    health: "/",
  },
  // ⚠️ Astro's dev server is Vite under the hood and host-checks the same way, so
  // an Astro app served through the gateway will also 403. Astro has no
  // loadConfigFromFile export, so the Vite wrapper above can't be reused verbatim
  // — an Astro app needs its own prepareFiles wrapper (astro.config with
  // `vite: { server: { allowedHosts } }` passthrough). Wire it when the first
  // Astro app is ingested into the dev-lane (none today). See the Viken write-up.
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
  // Expo / React Native (divisão mobile). O "preview" é o Metro (dev server):
  // ele não renderiza a app — serve bundle JS pro dev client instalado no
  // aparelho (deep link <scheme>://expo-development-client/?url=<preview-url>).
  // Fast Refresh via WebSocket, proxiado pelo gateway como qualquer HMR.
  // EXPO_PACKAGER_PROXY_URL faz o manifest apontar pro host público do preview
  // (mesmo padrão do metro.coldcodelabs.com no ymir, provado 2026-07-08).
  {
    id: "expo",
    label: "Expo (Metro)",
    supported: true,
    detect: {
      anyDep: ["expo"],
      anyFile: ["app.config.ts", "app.config.js", "app.json"],
      anyScriptMatches: "expo start",
    },
    commands: {
      dev: "{exec} expo start --dev-client --port $PORT",
      build: "{exec} expo export --platform=web",
      start: "{exec} expo start --dev-client --port $PORT",
    },
    health: "/status",
    // The dev client's real entry request — a broken import (the "./index" /
    // UnableToResolveError class) makes Metro answer this with a JSON error while
    // /status stays 200. The supervisor probes it to detect + self-heal.
    bundleProbe:
      "/node_modules/expo-router/entry.bundle?platform=ios&dev=true&transform.routerRoot=src%2Fapp",
    // ⚠️ NÃO setar CI=1: Metro em CI mode DESLIGA o file watcher ("reloads are
    // disabled") — mata o Fast Refresh do loop dev-lane. O spawn já é non-TTY,
    // então o expo não trava em prompt; EXPO_NO_TELEMETRY corta o resto.
    env: { EXPO_PACKAGER_PROXY_URL: "$PUBLIC_URL", EXPO_NO_TELEMETRY: "1" },
  },
];
