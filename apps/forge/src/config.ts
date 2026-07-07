/** Runner configuration from the environment. The runner is a small daemon: it
 *  polls the control plane, forges the card with @brokk/forge (native, over afl)
 *  in a worktree, opens a PR. */
export interface RunnerConfig {
  controlUrl: string;
  runnerSecret: string;
  /** Host label reported on register. */
  host: string;
  /** Where bare clones + worktrees live. */
  workDir: string;
  /** Gateway base url (ANTHROPIC_BASE_URL) the forge engine POSTs to — LiteLLM →
   *  Ratatoskr. */
  anthropicBaseUrl: string;
  /** Legacy direct API key. Unused by the native forge (gateway-only) — kept for
   *  the preview supervisor / env compatibility. */
  anthropicApiKey: string;
  /** Gateway bearer token (ANTHROPIC_AUTH_TOKEN) — a per-tool LiteLLM virtual
   *  key. The forge engine sends it to the gateway, which (Ratatoskr) injects the
   *  real subscription credential upstream. */
  anthropicAuthToken: string;
  githubToken: string;
  /** Shell command run in the worktree to verify the agent's work before the PR
   *  (e.g. "pnpm install --silent && pnpm -r typecheck"). Empty = skip. */
  verifyCmd: string;
  /** Max self-heal rounds (#1): on a red verify, re-prompt the agent with the
   *  failure and forge a fix, up to this many times. 0 = verify once, no heal. */
  healAttempts: number;
  /** ADR 0017 dev-lane (Fase 3b): apps whose standalone `implement` cards forge in
   *  the shared persistent `dev` checkout and commit+push straight to `dev` (no
   *  per-card PR) — the Coolify dev-build is the hard gate. Matched on the repo
   *  name. Empty = every app keeps the PR flow (safe default); pilot = "logcheck".
   *  Plans/revise always stay on the PR path. BROKK_DEVLANE_APPS (comma-separated). */
  devLaneApps: Set<string>;
  /** When true, attach the Playwright MCP server to the forge agent so it can
   *  drive a real headless browser while forging (e.g. to check a running app
   *  against the card's acceptance criteria). Default OFF — when unset the agent
   *  behaves exactly as today (file/bash/git tools only, no browser). Toggled by
   *  BROKK_BROWSER ("1"/"true"). See engine.ts for the wiring. */
  browser: boolean;
  /** Headless Chromium binary the acceptance receipt (and browser checks) drive.
   *  Default /usr/bin/chromium (present on the surtr runner). BROKK_CHROMIUM. */
  chromiumPath: string;
  /** Poll interval (ms) between claim attempts when the queue is empty. */
  pollIntervalMs: number;

  // ── Preview supervisor ──────────────────────────────────────────────────────

  /** Hauldr control-plane base URL (e.g. https://api.hauldr.io). Empty = Hauldr
   *  provisioning is skipped (app starts without Hauldr env vars). */
  hauldrControlUrl: string;
  /** Bearer token for the Hauldr API. */
  hauldrToken: string;
  /** Shell command used to boot a preview app. `$PORT` is substituted with the
   *  allocated port number. Per-project override: BROKK_PREVIEW_CMD env var.
   *  Default: `next build && next start -p $PORT` (Next.js apps). */
  previewCmd: string;
  /** Shell command used to boot a `mode='dev'` preview (a Sindri session's live
   *  checkout) — `next dev` with HMR so the agent's edits hot-reload. `$PORT` is
   *  substituted. Override: BROKK_PREVIEW_DEV_CMD. `pnpm exec next dev` resolves
   *  the local binary; `-H 0.0.0.0` is load-bearing (gateway proxies 127.0.0.1). */
  previewDevCmd: string;
  /** How long a preview lives without a touch before the reaper kills it (ms).
   *  Configurable via BROKK_PREVIEW_TTL_MS. Default: 45 minutes. */
  previewTtlMs: number;
  /** How long (ms) the supervisor waits for a freshly-spawned preview to answer
   *  its health path before flipping it 'live' anyway (degraded). Covers the
   *  `pnpm install` + first compile so the pane shows a spinner, not a broken
   *  iframe. Configurable via BROKK_PREVIEW_HEALTH_TIMEOUT_MS. Default: 2 min. */
  previewHealthTimeoutMs: number;
  /** Lowest port the supervisor may allocate for preview processes. */
  previewPortMin: number;
  /** Highest port (inclusive) the supervisor may allocate for preview processes. */
  previewPortMax: number;
  /** When true (default), the supervisor deprovisions a preview's Hauldr compute
   *  (auth + rest, keeping the DB) once it stops/expires, so an idle backend
   *  costs zero containers. BROKK_PREVIEW_EPHEMERAL=false keeps it standing. */
  previewEphemeral: boolean;
  /** Hauldr projects the supervisor must NEVER deprovision — pinned standing
   *  envs (e.g. a client staging DB) that happen to share a preview slug.
   *  CSV via BROKK_PREVIEW_PINNED. */
  previewPinned: Set<string>;
  /** Directory holding per-app preview secrets as `<hauldrProject>.env` files
   *  (e.g. OPENAI_API_KEY pointing at the LiteLLM gateway). Merged into the
   *  preview's spawn env at boot — kept OUTSIDE the worktree so the secrets
   *  survive worktree refreshes and never leak across apps. Empty = disabled.
   *  Set via BROKK_PREVIEW_SECRETS_DIR. */
  previewSecretsDir: string;
}

export function loadRunnerConfig(env = process.env): RunnerConfig {
  const controlUrl = env.BROKK_CONTROL_URL ?? "http://localhost:8789";
  const runnerSecret = env.BROKK_RUNNER_SECRET ?? "";
  if (!runnerSecret) {
    throw new Error("BROKK_RUNNER_SECRET is required for the runner");
  }
  return {
    controlUrl: controlUrl.replace(/\/$/, ""),
    runnerSecret,
    host: env.BROKK_RUNNER_HOST ?? env.HOSTNAME ?? "brokk-runner",
    workDir: env.BROKK_RUNNER_WORKDIR ?? "/tmp/brokk",
    // Empty = direct to Anthropic. Set to the headroom proxy to route through it.
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? "",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    anthropicAuthToken: env.ANTHROPIC_AUTH_TOKEN ?? "",
    githubToken: env.GITHUB_TOKEN ?? "",
    verifyCmd: env.BROKK_VERIFY_CMD ?? "",
    healAttempts: Number(env.BROKK_HEAL_ATTEMPTS ?? 2),
    devLaneApps: new Set(
      (env.BROKK_DEVLANE_APPS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    browser: /^(1|true|yes)$/i.test(env.BROKK_BROWSER ?? ""),
    chromiumPath: env.BROKK_CHROMIUM ?? "/usr/bin/chromium",
    pollIntervalMs: Number(env.BROKK_RUNNER_POLL_MS ?? 3000),
    // Preview supervisor
    hauldrControlUrl: (env.HAULDR_CONTROL_URL ?? "").replace(/\/$/, ""),
    hauldrToken: env.HAULDR_TOKEN ?? "",
    previewCmd: env.BROKK_PREVIEW_CMD ?? "next build && next start -p $PORT",
    previewDevCmd:
      env.BROKK_PREVIEW_DEV_CMD ??
      // `pnpm exec` resolves the local `next` from node_modules/.bin and forwards
      // args cleanly (bare `next` isn't on PATH under `sh -c`; `pnpm run dev --`
      // leaks the `--` into next's argv). Verified e2e on the dev lane.
      "pnpm install --no-frozen-lockfile --prod=false && pnpm exec next dev -p $PORT -H 0.0.0.0",
    previewTtlMs: Number(env.BROKK_PREVIEW_TTL_MS ?? 45 * 60 * 1000),
    previewHealthTimeoutMs: Number(env.BROKK_PREVIEW_HEALTH_TIMEOUT_MS ?? 2 * 60 * 1000),
    previewPortMin: Number(env.BROKK_PREVIEW_PORT_MIN ?? 4100),
    previewPortMax: Number(env.BROKK_PREVIEW_PORT_MAX ?? 4199),
    previewEphemeral: (env.BROKK_PREVIEW_EPHEMERAL ?? "true") !== "false",
    previewPinned: new Set(
      (env.BROKK_PREVIEW_PINNED ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    previewSecretsDir: env.BROKK_PREVIEW_SECRETS_DIR ?? "",
  };
}
