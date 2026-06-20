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
  /** Poll interval (ms) between claim attempts when the queue is empty. */
  pollIntervalMs: number;
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
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? "http://localhost:8787",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    githubToken: env.GITHUB_TOKEN ?? "",
    pollIntervalMs: Number(env.BROKK_RUNNER_POLL_MS ?? 3000),
  };
}
