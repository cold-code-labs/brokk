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
//
// Also injects `brokk-forge-veil`: a small HMR overlay so full-reloads / chunk
// swaps don't flash a blank iframe (v0/lovable-style) while Sindri is forging.
const VITE_PREVIEW_CONFIG_PATH = ".brokk/vite.preview.config.mjs";
/** Client module source for the virtual veil plugin (JSON-stringified into the
 *  written config so quotes/newlines stay safe). */
const VITE_FORGE_VEIL_CLIENT = `
const TIPS = [
  "Forging…",
  "Heating the billet…",
  "Sindri at the anvil…",
  "Quenching…",
  "Hammering the seam…",
];
let tip = 0;
let root = null;
let hideTimer = 0;

function ensure() {
  if (root) return root;
  root = document.createElement("div");
  root.id = "brokk-forge-veil";
  root.innerHTML = \`
    <style>
      #brokk-forge-veil{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;
        background:radial-gradient(120% 80% at 50% 0%,#2a3d3a 0%,#152422 55%,#0e1817 100%);
        color:#e8efed;font-family:ui-sans-serif,system-ui,sans-serif;opacity:0;pointer-events:none;
        transition:opacity .18s ease}
      #brokk-forge-veil[data-on="1"]{opacity:1;pointer-events:auto}
      #brokk-forge-veil .bk-card{display:flex;flex-direction:column;align-items:center;gap:14px;padding:28px 32px;text-align:center}
      #brokk-forge-veil .bk-spark{width:42px;height:42px;border-radius:12px;background:linear-gradient(145deg,#ed765d,#c45a45);
        box-shadow:0 0 0 1px rgba(237,118,93,.35),0 12px 40px rgba(237,118,93,.25);animation:bk-pulse 1.1s ease-in-out infinite}
      #brokk-forge-veil .bk-tip{font-size:15px;font-weight:600;letter-spacing:-.02em}
      #brokk-forge-veil .bk-sub{font-size:12px;opacity:.65}
      @keyframes bk-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
    </style>
    <div class="bk-card">
      <div class="bk-spark" aria-hidden="true"></div>
      <div class="bk-tip" data-tip>Forging…</div>
      <div class="bk-sub">preview updating</div>
    </div>
  \`;
  document.documentElement.appendChild(root);
  return root;
}

function show() {
  const el = ensure();
  el.dataset.on = "1";
  const tipEl = el.querySelector("[data-tip]");
  if (tipEl) tipEl.textContent = TIPS[tip++ % TIPS.length];
  if (hideTimer) clearTimeout(hideTimer);
}

function hide() {
  if (!root) return;
  // Brief hold so a burst of HMR events doesn't flicker.
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (root) root.dataset.on = "0";
  }, 120);
}

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", show);
  import.meta.hot.on("vite:afterUpdate", hide);
  import.meta.hot.on("vite:beforeFullReload", show);
  import.meta.hot.on("vite:invalidate", show);
  import.meta.hot.on("vite:ws:disconnect", show);
  import.meta.hot.on("vite:ws:connect", hide);
}
`.trim();

const VITE_PREVIEW_CONFIG = `import { loadConfigFromFile, mergeConfig } from "vite";
const PREVIEW_HOSTS = [".preview.coldcodelabs.com"];
const VEIL_CLIENT = ${JSON.stringify(VITE_FORGE_VEIL_CLIENT)};

function brokkForgeVeil() {
  return {
    name: "brokk-forge-veil",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "module" },
          children: VEIL_CLIENT,
          injectTo: "body",
        },
      ];
    },
  };
}

export default async (env) => {
  const loaded = await loadConfigFromFile(env, undefined, process.cwd());
  return mergeConfig(loaded?.config ?? {}, {
    server: {
      allowedHosts: PREVIEW_HOSTS,
      // Brokk iframe is reverse-proxied (preview-proxy). Vite HMR over that WS
      // flaps (disconnect → invalidate → removeStyle) and leaves the app
      // unstyled after a brief good first paint. Prefer stable inject-once.
      hmr: false,
      watch: null,
    },
    preview: { allowedHosts: PREVIEW_HOSTS },
    plugins: [brokkForgeVeil()],
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
      // BROKK-37: do NOT put `--turbo`/`--turbopack` here. Next 16 defaults to
      // Turbopack (~4GB/app); `densifyNextPreview` injects `--webpack` for Next ≥16
      // at resolve time. Next 15 already defaults to webpack — `--webpack` would
      // crash (`unknown option`), so the template stays version-agnostic. Forge
      // still ensures @next/swc-linux-x64-gnu (BROKK-31) for native bindings; the
      // BROKK_NEXT_WEBPACK=1 escape hatch remains for a worktree that can't load
      // SWC even so.
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
