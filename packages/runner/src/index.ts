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
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { RunEvent, Repository, Run, RunUsage, Task } from "@brokk/core";
import { runBranch } from "@brokk/core";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";

const execAsync = promisify(exec);
import { GhProvider } from "./git.js";
import { ClaudeAgentEngine } from "./engine.js";
import { HauldrClient } from "./hauldr.js";
import { PreviewSupervisor } from "./preview.js";

type EventInput = Omit<RunEvent, "id" | "runId" | "seq" | "at">;
type ClaimAuth = { source: "seat" | "env"; token: string | null; subscriptionId: string | null };
type Claimed = { task: Task; run: Run; auth?: ClaimAuth };

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

  // ── Preview supervisor (parallel loop) ──────────────────────────────────────
  // Runs alongside the forge claim loop; each is independent.
  const hauldr = cfg.hauldrControlUrl
    ? new HauldrClient(cfg.hauldrControlUrl, cfg.hauldrToken)
    : null;
  if (!hauldr) {
    console.log(
      "[brokk-runner] HAULDR_CONTROL_URL not set — preview Hauldr provisioning disabled",
    );
  }
  const supervisor = new PreviewSupervisor(cfg, git, hauldr);
  const supervisorDone = supervisor.run(() => stopping);
  // ────────────────────────────────────────────────────────────────────────────

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
  await supervisorDone; // wait for preview supervisor graceful shutdown
  console.log("[brokk-runner] stopped");
}

async function handleRun(
  cfg: RunnerConfig,
  git: GhProvider,
  engine: ClaudeAgentEngine,
  { task, run, auth }: Claimed,
): Promise<void> {
  console.log(
    `[brokk-runner] claimed task "${task.title}" (run ${run.id})` +
      (auth?.source === "seat" ? ` · seat ${auth.subscriptionId?.slice(0, 8)}` : " · ambient token"),
  );
  const buffer = new EventBuffer(cfg, run.id);
  const repo = await resolveRepository(task); // TODO(P1): enrich /runner/claim with project+repo
  const baseBranch = task.baseBranch ?? repo.defaultBranch;
  // Revise tasks (the Eitri loop) update an existing PR branch; implement tasks
  // fork a fresh branch off base.
  const isRevise = task.kind === "revise" && !!task.branch;
  const branch = isRevise ? task.branch! : run.branch ?? runBranch(task.title, run.id);
  let worktreePath: string | undefined;

  try {
    buffer.emit({ type: "status", payload: { phase: isRevise ? "worktree_revise" : "worktree", branch, baseBranch } });
    const wt = isRevise
      ? await git.checkoutBranch({ repo, branch })
      : await git.worktree({ repo, baseBranch, branch });
    worktreePath = wt.path;

    const usage: RunUsage = await engine.run({
      task: { id: task.id, title: task.title, body: task.body, labels: task.labels },
      run: { id: run.id, branch, model: run.model, authMode: run.authMode },
      cwd: wt.path,
      model: run.model ?? process.env.BROKK_DEFAULT_MODEL ?? "sonnet",
      authMode: run.authMode ?? "subscription",
      authToken: auth?.token ?? undefined,
      allowedTools: [],
      emit: (e) => buffer.emit(e),
    });

    // Verify the agent's work in the worktree before opening the PR. The result
    // is attached to the PR and decides the run's outcome — this is what lets a
    // reviewer (human now, Eitri later) trust a green PR.
    let verify: VerifyResult | null = null;
    if (cfg.verifyCmd) {
      buffer.emit({ type: "status", payload: { phase: "verify_start", cmd: cfg.verifyCmd } });
      verify = await runVerify(cfg.verifyCmd, wt.path);
      buffer.emit({ type: "status", payload: { phase: "verify_done", ok: verify.ok } });
      buffer.emit({
        type: "log",
        payload: { level: verify.ok ? "info" : "error", verify: verify.output.slice(-4000) },
      });
    }

    buffer.emit({ type: "status", payload: { phase: "push", branch } });
    await git.push({
      cwd: wt.path,
      branch,
      message: isRevise ? `brokk: revise — ${task.title}` : `brokk: ${task.title}`,
    });

    // Revise updates the existing PR (no new one); implement opens a PR.
    const pr = isRevise
      ? { url: task.prUrl ?? "", number: task.prNumber }
      : await git.openPr({ cwd: wt.path, repo, branch, baseBranch, title: task.title, body: prBody(task, verify) });
    buffer.emit({ type: "status", payload: { phase: isRevise ? "pr_updated" : "pr_opened", url: pr.url } });

    // Red verify → the run is a failure even though a PR exists (so the diff is
    // still inspectable). Green / no-verify → succeeded.
    const failed = verify ? !verify.ok : false;
    await buffer.flush();
    await api(cfg, "POST", `/runs/${run.id}/complete`, {
      status: failed ? "failed" : "succeeded",
      prUrl: pr.url,
      error: failed ? `verify failed:\n${verify!.output.slice(-1500)}` : undefined,
      usage,
    });
    console.log(
      `[brokk-runner] run ${run.id} → PR ${pr.url}` +
        (verify ? ` · verify ${verify.ok ? "✓" : "✗"}` : ""),
    );
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

type VerifyResult = { ok: boolean; output: string };

/** Run the verify command in the worktree. Never throws — a non-zero exit is a
 *  failed verification, not a runner crash. */
async function runVerify(cmd: string, cwd: string): Promise<VerifyResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      env: { ...process.env },
      maxBuffer: 1024 * 1024 * 64,
      timeout: 8 * 60 * 1000,
    });
    return { ok: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (err: any) {
    const out = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}\n${err?.message ?? err}`.trim();
    return { ok: false, output: out };
  }
}

function prBody(task: Task, verify: VerifyResult | null): string {
  const lines = [task.body || "_(no description)_", ""];
  if (verify) {
    lines.push(
      `**Verify:** ${verify.ok ? "✅ passed" : "❌ failed"}`,
      "",
      "<details><summary>verify output</summary>",
      "",
      "```",
      verify.output.slice(-3000),
      "```",
      "",
      "</details>",
      "",
    );
  }
  lines.push("---", `🔨 Forged by **Brokk** · task \`${task.id}\``);
  return lines.join("\n");
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
