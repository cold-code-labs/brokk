/**
 * @brokk/runner — the daemon that turns queued cards into Pull Requests.
 *
 * Loop:  register → claim → worktree → Claude Agent SDK → push → `gh pr create`
 *        → POST /runs/:id/complete.  Many runners can pull from one queue.
 *
 * Runs on surtr (git, gh, claude, headroom on PATH). Talks to the control plane
 * over HTTP with the shared runner secret. See ARCHITECTURE.md §3/§7/§8.
 *
 * ⚠️ This is the P0 skeleton: structurally complete, UNVERIFIED at runtime.
 *    The P1 spike (1 card → real PR) is where this gets exercised.
 */
import type { RunEvent, Repository, Run, RunUsage, Task } from "@brokk/core";
import { runBranch } from "@brokk/core";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";
import { GhProvider } from "./git.js";
import { ClaudeAgentEngine } from "./engine.js";

type EventInput = Omit<RunEvent, "id" | "runId" | "seq" | "at">;
type Claimed = { task: Task; run: Run };

async function main() {
  const cfg = loadRunnerConfig();
  const git = new GhProvider({ workDir: cfg.workDir, githubToken: cfg.githubToken });
  const engine = new ClaudeAgentEngine({
    anthropicBaseUrl: cfg.anthropicBaseUrl,
    anthropicApiKey: cfg.anthropicApiKey,
  });

  const runnerId = await register(cfg);
  console.log(`[brokk-runner] registered as ${runnerId} → ${cfg.controlUrl}`);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const heartbeat = setInterval(
    () => api(cfg, "POST", "/runner/heartbeat", { runnerId }).catch(() => {}),
    15_000,
  );

  while (!stopping) {
    let claimed: Claimed | null = null;
    try {
      claimed = await api<Claimed | null>(cfg, "POST", "/runner/claim", { runnerId }, 204);
    } catch (err) {
      console.error("[brokk-runner] claim failed:", err);
    }
    if (!claimed) {
      await sleep(cfg.pollIntervalMs);
      continue;
    }
    await handleRun(cfg, git, engine, claimed).catch((err) =>
      console.error(`[brokk-runner] run ${claimed?.run.id} crashed:`, err),
    );
  }

  clearInterval(heartbeat);
  console.log("[brokk-runner] stopped");
}

async function handleRun(
  cfg: RunnerConfig,
  git: GhProvider,
  engine: ClaudeAgentEngine,
  { task, run }: Claimed,
): Promise<void> {
  console.log(`[brokk-runner] claimed task "${task.title}" (run ${run.id})`);
  const buffer = new EventBuffer(cfg, run.id);
  const repo = await resolveRepository(task); // TODO(P1): enrich /runner/claim with project+repo
  const baseBranch = task.baseBranch ?? repo.defaultBranch;
  const branch = run.branch ?? runBranch(task.title, run.id);
  let worktreePath: string | undefined;

  try {
    buffer.emit({ type: "status", payload: { phase: "worktree", branch, baseBranch } });
    const wt = await git.worktree({ repo, baseBranch, branch });
    worktreePath = wt.path;

    const usage: RunUsage = await engine.run({
      task: { id: task.id, title: task.title, body: task.body, labels: task.labels },
      run: { id: run.id, branch, model: run.model, authMode: run.authMode },
      cwd: wt.path,
      model: run.model ?? "claude-sonnet-4-5",
      authMode: run.authMode ?? "api_key",
      allowedTools: [],
      emit: (e) => buffer.emit(e),
    });

    buffer.emit({ type: "status", payload: { phase: "push", branch } });
    await git.push({ cwd: wt.path, branch, message: `brokk: ${task.title}` });

    const pr = await git.openPr({
      cwd: wt.path,
      repo,
      branch,
      baseBranch,
      title: task.title,
      body: prBody(task),
    });
    buffer.emit({ type: "status", payload: { phase: "pr_opened", url: pr.url } });

    await buffer.flush();
    await api(cfg, "POST", `/runs/${run.id}/complete`, {
      status: "succeeded",
      prUrl: pr.url,
      usage,
    });
    console.log(`[brokk-runner] run ${run.id} → PR ${pr.url}`);
  } catch (err) {
    buffer.emit({ type: "log", payload: { level: "error", error: String(err) } });
    await buffer.flush().catch(() => {});
    await api(cfg, "POST", `/runs/${run.id}/complete`, {
      status: "failed",
      error: String(err),
    }).catch(() => {});
    // Keep the worktree on failure for debugging (ARCHITECTURE.md §8).
    return;
  }

  if (worktreePath) await git.cleanup({ path: worktreePath }).catch(() => {});
}

/** Batches events and flushes them to /runs/:id/events to avoid chatty POSTs. */
class EventBuffer {
  private queue: { type: RunEvent["type"]; payload: unknown }[] = [];
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly cfg: RunnerConfig,
    private readonly runId: string,
  ) {}

  emit(e: EventInput) {
    this.queue.push({ type: e.type, payload: e.payload });
    if (this.queue.length >= 20) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 1000);
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.length) return;
    const events = this.queue.splice(0, this.queue.length);
    await api(this.cfg, "POST", `/runs/${this.runId}/events`, { events }).catch((err) =>
      console.error("[brokk-runner] event flush failed:", err),
    );
  }
}

async function register(cfg: RunnerConfig): Promise<string> {
  const res = await api<{ runnerId: string }>(cfg, "POST", "/runner/register", {
    host: cfg.host,
    capabilities: ["claude", "git", "gh"],
  });
  return res.runnerId;
}

/**
 * TODO(P1): the control plane's /runner/claim currently returns only { task, run }.
 * The runner needs the repository (clone url, default branch) + project agent config.
 * Until claim is enriched, resolve from env as a stopgap so the skeleton is coherent.
 */
async function resolveRepository(task: Task): Promise<Repository> {
  const full = process.env.BROKK_DEFAULT_REPO; // "owner/name"
  if (!full || !full.includes("/")) {
    throw new Error(
      `cannot resolve repository for task ${task.id}: set BROKK_DEFAULT_REPO ` +
        `(TODO(P1): enrich /runner/claim with project+repository)`,
    );
  }
  const [owner, name] = full.split("/", 2);
  return {
    id: "env",
    fullName: full,
    owner: owner!,
    name: name!,
    defaultBranch: process.env.BROKK_DEFAULT_BRANCH ?? "main",
    cloneUrl: `https://github.com/${full}.git`,
    installationId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function prBody(task: Task): string {
  return [
    task.body || "_(no description)_",
    "",
    "---",
    `🔨 Forged by **Brokk** · task \`${task.id}\``,
  ].join("\n");
}

/** Thin HTTP helper for the runner-facing (shared-secret) endpoints.
 *  `emptyStatus` (e.g. 204) resolves to null instead of parsing a body. */
async function api<T = unknown>(
  cfg: RunnerConfig,
  method: string,
  path: string,
  body?: unknown,
  emptyStatus?: number,
): Promise<T> {
  const res = await fetch(`${cfg.controlUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.runnerSecret}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (emptyStatus && res.status === emptyStatus) return null as T;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error("[brokk-runner] fatal:", err);
  process.exit(1);
});
