/** Runner configuration from the environment. The runner is a small daemon: it
 *  polls the control plane, runs the Claude Agent SDK in a worktree, opens a PR. */
export interface RunnerConfig {
  controlUrl: string;
  runnerSecret: string;
  /** Host label reported on register. */
  host: string;
  /** Where bare clones + worktrees live. */
  workDir: string;
  /** Headroom / gateway base url exported to the Agent SDK. */
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  githubToken: string;
  /** Shell command run in the worktree to verify the agent's work before the PR
   *  (e.g. "pnpm install --silent && pnpm -r typecheck"). Empty = skip. */
  verifyCmd: string;
  /** Max self-heal rounds (#1): on a red verify, re-prompt the agent with the
   *  failure and forge a fix, up to this many times. 0 = verify once, no heal. */
  healAttempts: number;
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
  /** How long a preview lives without a touch before the reaper kills it (ms).
   *  Configurable via BROKK_PREVIEW_TTL_MS. Default: 45 minutes. */
  previewTtlMs: number;
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
    githubToken: env.GITHUB_TOKEN ?? "",
    verifyCmd: env.BROKK_VERIFY_CMD ?? "",
    healAttempts: Number(env.BROKK_HEAL_ATTEMPTS ?? 2),
    pollIntervalMs: Number(env.BROKK_RUNNER_POLL_MS ?? 3000),
    // Preview supervisor
    hauldrControlUrl: (env.HAULDR_CONTROL_URL ?? "").replace(/\/$/, ""),
    hauldrToken: env.HAULDR_TOKEN ?? "",
    previewCmd: env.BROKK_PREVIEW_CMD ?? "next build && next start -p $PORT",
    previewTtlMs: Number(env.BROKK_PREVIEW_TTL_MS ?? 45 * 60 * 1000),
    previewPortMin: Number(env.BROKK_PREVIEW_PORT_MIN ?? 4100),
    previewPortMax: Number(env.BROKK_PREVIEW_PORT_MAX ?? 4199),
    previewEphemeral: (env.BROKK_PREVIEW_EPHEMERAL ?? "true") !== "false",
    previewPinned: new Set(
      (env.BROKK_PREVIEW_PINNED ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
}
