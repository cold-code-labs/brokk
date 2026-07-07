/**
 * @brokk/forge-app — the daemon that turns queued cards into Pull Requests.
 *
 * Loop:  register → claim → worktree → @brokk/forge (native, over afl) → push →
 *        `gh pr create` → POST /runs/:id/complete.  Many runners pull one queue.
 *
 * Runs on surtr (git, gh, headroom on PATH). Talks to the control plane over HTTP
 * with the shared runner secret. See ARCHITECTURE.md §3/§7/§8.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AcceptanceReceipt, Plan, Project, RepoMemory, RunEvent, Repository, Run, RunResult, Task } from "@brokk/core";
import { runBranch } from "@brokk/core";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";

const execAsync = promisify(exec);
import { GhProvider } from "./git.js";
import { ForgeEngine } from "@brokk/forge";
import { HauldrClient } from "./hauldr.js";
import { runAcceptanceReceipt } from "./acceptance.js";
import { PreviewSupervisor, loadAppSecrets } from "./preview.js";
import { buildRepoMap } from "./repomap.js";
import { type ForgeTrace, flushTraces, startForgeTrace } from "./tracer.js";

type EventInput = Omit<RunEvent, "id" | "runId" | "seq" | "at">;
type ClaimAuth = { source: "seat" | "env"; token: string | null; subscriptionId: string | null };
type Claimed = {
  task: Task;
  run: Run;
  /** Resolved by the control plane (footgun fix — no BROKK_DEFAULT_REPO guess). */
  repository?: Repository;
  project?: Project;
  /** If the card belongs to a plan, the shared feature branch it composes into. */
  plan?: Plan | null;
  auth?: ClaimAuth;
  /** Per-repo memory (#2) the control plane attached, for the forge prompt. */
  memory?: RepoMemory[];
};

async function main() {
  const cfg = loadRunnerConfig();
  const git = new GhProvider({ workDir: cfg.workDir, githubToken: cfg.githubToken });
  // Native forge over @brokk/afl (no Agent SDK). Gateway-only auth: base url →
  // LiteLLM/Ratatoskr, bearer = the LiteLLM virtual key (Ratatoskr injects the
  // real seat upstream). The legacy api-key / per-run OAuth seat path is retired.
  const engine = new ForgeEngine({
    gatewayUrl: cfg.anthropicBaseUrl,
    authToken: cfg.anthropicAuthToken,
    browser: cfg.browser,
  });

  const runnerId = await register(cfg);
  console.log(`[forge] registered as ${runnerId} → ${cfg.controlUrl}`);

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
      "[forge] HAULDR_CONTROL_URL not set — preview Hauldr provisioning disabled",
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
      console.error("[forge] claim failed:", err);
    }
    if (!claimed) {
      await sleep(cfg.pollIntervalMs);
      continue;
    }
    // ADR 0017 Fase 3b: a standalone implement card for a dev-lane app forges in the
    // shared dev checkout and commits straight to `dev` (no PR). Plans/revise, and
    // any app not in BROKK_DEVLANE_APPS, keep the PR flow.
    const run =
      isDevLaneCard(cfg, claimed)
        ? runDevLane(cfg, git, engine, claimed)
        : handleRun(cfg, git, engine, claimed);
    await run.catch((err) =>
      console.error(`[forge] run ${claimed?.run.id} crashed:`, err),
    );
  }

  clearInterval(heartbeat);
  await supervisorDone; // wait for preview supervisor graceful shutdown
  console.log("[forge] stopped");
}

async function handleRun(
  cfg: RunnerConfig,
  git: GhProvider,
  engine: ForgeEngine,
  { task, run, repository, project, plan, auth, memory }: Claimed,
): Promise<void> {
  console.log(
    `[forge] claimed task "${task.title}" (run ${run.id})` +
      (plan ? ` · plan ${plan.id.slice(0, 8)} [${task.planKey}]` : "") +
      (auth?.source === "seat" ? ` · seat ${auth.subscriptionId?.slice(0, 8)}` : " · ambient token"),
  );
  const buffer = new EventBuffer(cfg, run.id);
  // Repo comes resolved from the control plane now (footgun fix); fall back to
  // the env stopgap only if an old control plane didn't send it.
  const repo = repository ?? (await resolveRepository(task));
  // A plan card forges on the plan's shared feature branch; revise updates an
  // existing PR branch; a standalone implement card forks a fresh branch.
  const isPlan = !!plan;
  const isRevise = task.kind === "revise" && !!task.branch;
  const baseBranch = plan?.baseBranch ?? task.baseBranch ?? project?.baseBranch ?? repo.defaultBranch;
  const branch = isPlan
    ? plan!.featureBranch
    : isRevise
      ? task.branch!
      : (run.branch ?? runBranch(task.title, run.id));
  let worktreePath: string | undefined;
  let trace: ForgeTrace | null = null;

  try {
    const phase = isPlan ? "worktree_plan" : isRevise ? "worktree_revise" : "worktree";
    buffer.emit({ type: "status", payload: { phase, branch, baseBranch } });
    const wt = isPlan
      ? await git.featureWorktree({ repo, baseBranch, featureBranch: branch })
      : isRevise
        ? await git.checkoutBranch({ repo, branch })
        : await git.worktree({ repo, baseBranch, branch });
    worktreePath = wt.path;

    // Per-forge Langfuse trace (path-b): folds the engine's emit() stream into one
    // trace (spans per phase, heal events, usage, verify/heal scores). Best-effort.
    const model = run.model ?? process.env.BROKK_DEFAULT_MODEL ?? "sonnet";
    trace = startForgeTrace({
      title: task.title,
      body: task.body,
      model,
      metadata: {
        runId: run.id,
        cardId: task.id,
        repo: repo.fullName,
        branch,
        baseBranch,
        kind: task.kind,
        planId: plan?.id ?? null,
        planKey: task.planKey ?? null,
      },
    });

    // Forge → verify → self-heal (#1). The engine owns the loop: it forges, runs
    // the verify command we hand it (in the worktree), and on a red verify
    // re-prompts itself with the failure to fix — up to cfg.healAttempts rounds.
    // The final verify outcome decides the run's success and rides on the PR.
    const result: RunResult = await engine.run({
      task: {
        id: task.id,
        title: task.title,
        body: task.body,
        labels: task.labels,
        acceptance: task.acceptance,
      },
      run: { id: run.id, branch, model: run.model, authMode: run.authMode },
      cwd: wt.path,
      model,
      authMode: run.authMode ?? "subscription",
      authToken: auth?.token ?? undefined,
      allowedTools: [],
      memory: (memory ?? []).map((m) => `(${m.kind}) ${m.content}`),
      verify: cfg.verifyCmd ? () => runVerify(cfg.verifyCmd, wt.path) : undefined,
      maxHealAttempts: cfg.healAttempts,
      emit: (e) => {
        buffer.emit(e);
        trace?.onEvent(e);
      },
    });
    const usage = result.usage;
    const verify = result.verify;

    // Live-acceptance receipt (Nv2 QA): if the card shipped a `.brokk/acceptance.mjs`
    // check, boot the worktree app and run it — a green typecheck proves it compiles,
    // this proves it BEHAVES. Best-effort: a boot/check failure is a red receipt, not
    // a runner crash, and it does NOT (yet) fail the run — verify stays the gate.
    let receipt: Awaited<ReturnType<typeof runAcceptanceReceipt>> = null;
    if (cfg.browser) {
      // Best-effort per-app secrets so gated pages can render — keyed by the
      // project slug (the `<slug>.env` convention in previewSecretsDir). Absent
      // file → {} (the check script owns whatever else it needs to reach the UI).
      const bootEnv = project?.name
        ? loadAppSecrets(cfg.previewSecretsDir, project.name)
        : {};
      buffer.emit({ type: "status", payload: { phase: "acceptance" } });
      receipt = await runAcceptanceReceipt({
        wtPath: wt.path,
        cfg,
        bootEnv,
        log: (m) => console.log(m),
      }).catch((err) => {
        console.error("[forge] acceptance receipt error:", err);
        return null;
      });
      if (receipt?.ran) {
        buffer.emit({ type: "acceptance", payload: receipt });
        console.log(`[forge] acceptance ${receipt.ok ? "✓" : "✗"} for run ${run.id}`);
      }
    }

    buffer.emit({ type: "status", payload: { phase: "push", branch } });
    await git.push({
      cwd: wt.path,
      branch,
      message: isPlan
        ? `brokk: ${task.title} [${task.planKey}]`
        : isRevise
          ? `brokk: revise — ${task.title}`
          : `brokk: ${task.title}`,
    });

    // PR routing:
    //  - plan   → ONE shared PR (feature→base). The first card opens it; the
    //             control plane records it so later cards reuse the same PR.
    //  - revise → update the existing PR (no new one).
    //  - implement → open a fresh PR.
    let pr: { url: string; number: number | null };
    let prPhase = "pr_opened";
    if (isPlan) {
      if (plan!.prUrl) {
        pr = { url: plan!.prUrl, number: plan!.prNumber };
        prPhase = "pr_reused";
      } else {
        const opened = await git.openPr({
          cwd: wt.path,
          repo,
          branch,
          baseBranch,
          title: `${plan!.summary}`,
          body: planPrBody(plan!, verify, receipt),
        });
        const updated = await api<{ prUrl: string | null; prNumber: number | null }>(
          cfg,
          "POST",
          `/runner/plans/${plan!.id}/pr`,
          { url: opened.url, number: opened.number },
        ).catch(() => null);
        pr = { url: updated?.prUrl ?? opened.url, number: updated?.prNumber ?? opened.number };
      }
    } else if (isRevise) {
      pr = { url: task.prUrl ?? "", number: task.prNumber };
      prPhase = "pr_updated";
    } else {
      pr = await git.openPr({
        cwd: wt.path,
        repo,
        branch,
        baseBranch,
        title: task.title,
        body: prBody(task, verify, receipt),
      });
    }
    buffer.emit({ type: "status", payload: { phase: prPhase, url: pr.url } });

    // Red verify → the run is a failure even though a PR exists (so the diff is
    // still inspectable). Green / no-verify → succeeded.
    const failed = verify ? !verify.ok : false;
    trace?.complete({ verify, healAttempts: result.healAttempts, usage, prUrl: pr.url });
    await buffer.flush();
    await api(cfg, "POST", `/runs/${run.id}/complete`, {
      status: failed ? "failed" : "succeeded",
      prUrl: pr.url,
      prNumber: pr.number ?? undefined,
      error: failed ? `verify failed:\n${verify!.output.slice(-1500)}` : undefined,
      usage,
    });
    console.log(
      `[forge] run ${run.id} → PR ${pr.url}` +
        (verify ? ` · verify ${verify.ok ? "✓" : "✗"}` : "") +
        (result.healAttempts ? ` · healed ×${result.healAttempts}` : ""),
    );

    // Refresh the warm index (#4) from the just-forged worktree, so the planner
    // sees the current tree next time. Best-effort — never fails the run. Skipped
    // for the env stopgap repo (id "env"), which isn't a real control-plane row.
    if (repository && repository.id !== "env") {
      try {
        const map = await buildRepoMap(wt.path);
        if (map) await api(cfg, "POST", `/runner/repos/${repository.id}/map`, { map });
      } catch (e) {
        console.error(`[forge] repo map refresh failed for ${repository.fullName}:`, e);
      }
    }
  } catch (err) {
    buffer.emit({ type: "log", payload: { level: "error", error: String(err) } });
    trace?.fail(err);
    await flushTraces();
    await buffer.flush().catch(() => {});
    await api(cfg, "POST", `/runs/${run.id}/complete`, {
      status: "failed",
      error: String(err),
    }).catch(() => {});
    // Keep the worktree on failure for debugging (ARCHITECTURE.md §8).
    return;
  }

  await flushTraces();
  if (worktreePath) await git.cleanup({ path: worktreePath }).catch(() => {});
}

/** ADR 0017 Fase 3b: is this claim a dev-lane card (forge in the shared dev checkout
 *  + commit straight to `dev`)? Only standalone `implement` cards for an app in
 *  BROKK_DEVLANE_APPS — plans (shared feature PR) and revise (update a PR) stay on
 *  the PR path, as does every app not opted in. */
function isDevLaneCard(cfg: RunnerConfig, { task, repository, project, plan }: Claimed): boolean {
  if (plan) return false;
  if (task.kind === "revise" && task.branch) return false;
  if (!repository || !project) return false;
  return cfg.devLaneApps.has(repository.name);
}

/** The shared dev checkout / Hauldr project slug for an app — MUST match the preview
 *  supervisor's `<app>_dev` (previews.ts) so the card and the HMR preview share one
 *  worktree and the CheckoutLocks key lines up. */
function devCheckoutSlug(appName: string): string {
  return `${appName}_dev`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/** Forge a dev-lane card: run the agent in a PRIVATE per-app `dev` checkout, gate on
 *  verify, then commit+push straight to `dev` — no per-card PR. The Coolify dev-build
 *  is the hard gate downstream (Fase 3d). Decoupled from the HMR preview by design
 *  (ADR 0017 revisto): the card's checkout (`devlane_<app>`) is SEPARATE from the
 *  preview's (`<app>_dev`), so a running `next dev` never races the card's git/pnpm —
 *  the preview reflects the change once it lands on dev (refresh), not mid-forge. The
 *  app lease (claimNext) keeps it serial per app, so this private checkout is never
 *  touched by two cards at once. */
async function runDevLane(
  cfg: RunnerConfig,
  git: GhProvider,
  engine: ForgeEngine,
  { task, run, repository, auth, memory }: Claimed,
): Promise<void> {
  const repo = repository!; // isDevLaneCard guarantees a resolved repository
  // Private card checkout — deliberately NOT the preview's `<app>_dev` worktree.
  const workName = `devlane_${devCheckoutSlug(repo.name)}`;
  console.log(
    `[forge] dev-lane: "${task.title}" (run ${run.id}) → ${repo.name} @ dev [${workName}]`,
  );
  const buffer = new EventBuffer(cfg, run.id);
  const model = run.model ?? process.env.BROKK_DEFAULT_MODEL ?? "sonnet";
  let trace: ForgeTrace | null = null;
  try {
    // Refresh the private card checkout to the dev tip — DETACHED so it never collides
    // with the preview's `dev` worktree (a local branch lives in only one worktree).
    buffer.emit({ type: "status", payload: { phase: "worktree", branch: "dev", baseBranch: "dev" } });
    const wt = await git.persistentCheckout({ repo, branch: "dev", name: workName, detach: true });

    trace = startForgeTrace({
      title: task.title,
      body: task.body,
      model,
      metadata: {
        runId: run.id,
        cardId: task.id,
        repo: repo.fullName,
        branch: "dev",
        baseBranch: "dev",
        kind: task.kind,
        planId: null,
        planKey: null,
      },
    });

    const result: RunResult = await engine.run({
      task: {
        id: task.id,
        title: task.title,
        body: task.body,
        labels: task.labels,
        acceptance: task.acceptance,
      },
      run: { id: run.id, branch: "dev", model: run.model, authMode: run.authMode },
      cwd: wt.path,
      model,
      authMode: run.authMode ?? "subscription",
      authToken: auth?.token ?? undefined,
      allowedTools: [],
      memory: (memory ?? []).map((m) => `(${m.kind}) ${m.content}`),
      verify: cfg.verifyCmd ? () => runVerify(cfg.verifyCmd, wt.path) : undefined,
      maxHealAttempts: cfg.healAttempts,
      // Dev-lane schema capability (ADR 0017 §6b): unlock apply_migration against
      // this app's `<app>_dev` DB when the control plane is configured. Same project
      // + endpoint the deploy migrates through → the file the agent writes and the
      // live schema stay identical, and the dev-build skips what's already applied.
      migration:
        cfg.hauldrControlUrl && cfg.hauldrToken
          ? {
              controlUrl: cfg.hauldrControlUrl,
              token: cfg.hauldrToken,
              project: devCheckoutSlug(repo.name),
            }
          : undefined,
      emit: (e) => {
        buffer.emit(e);
        trace?.onEvent(e);
      },
    });
    const verify = result.verify;
    const usage = result.usage;

    // Gate: a red verify must NOT land on dev. Fail the card — the agent's edits stay
    // in the checkout (HMR still shows them), but nothing is pushed.
    if (verify && !verify.ok) {
      trace?.complete({ verify, healAttempts: result.healAttempts, usage, prUrl: "" });
      await buffer.flush();
      await api(cfg, "POST", `/runs/${run.id}/complete`, {
        status: "failed",
        error: `verify failed:\n${verify.output.slice(-1500)}`,
        usage,
      });
      console.log(`[forge] dev-lane run ${run.id} → verify ✗ (not landed)`);
      return;
    }

    buffer.emit({ type: "status", payload: { phase: "push", branch: "dev" } });
    const sha = await git.commitPushIfChanged({
      cwd: wt.path,
      branch: "dev",
      message: `brokk: ${task.title}`,
    });
    trace?.complete({ verify, healAttempts: result.healAttempts, usage, prUrl: "" });
    await buffer.flush();
    await api(cfg, "POST", `/runs/${run.id}/complete`, { status: "succeeded", landed: true, usage });
    console.log(
      `[forge] dev-lane run ${run.id} → ${sha ? `pushed ${sha.slice(0, 8)} to dev` : "no changes"}` +
        (verify ? " · verify ✓" : "") +
        (result.healAttempts ? ` · healed ×${result.healAttempts}` : ""),
    );

    // Warm the repo map (best-effort), same as the PR flow.
    if (repo.id !== "env") {
      try {
        const map = await buildRepoMap(wt.path);
        if (map) await api(cfg, "POST", `/runner/repos/${repo.id}/map`, { map });
      } catch (e) {
        console.error(`[forge] repo map refresh failed for ${repo.fullName}:`, e);
      }
    }
  } catch (err) {
    buffer.emit({ type: "log", payload: { level: "error", error: String(err) } });
    trace?.fail(err);
    await buffer.flush().catch(() => {});
    await api(cfg, "POST", `/runs/${run.id}/complete`, {
      status: "failed",
      error: String(err),
    }).catch(() => {});
  } finally {
    await flushTraces();
    // NEVER cleanup — the private card checkout is persistent (node_modules survive).
  }
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
      console.error("[forge] event flush failed:", err),
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
    repoMap: null,
    repoMapAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

type VerifyResult = { ok: boolean; output: string };

/** Run the verify command in the worktree. Never throws — a non-zero exit is a
 *  failed verification, not a runner crash. */
async function runVerify(cmd: string, cwd: string): Promise<VerifyResult> {
  try {
    // The runner process runs with NODE_ENV=production, but verification needs the
    // worktree's *dev* toolchain (tsc, eslint, types) — `pnpm install` under
    // production omits devDependencies, which makes `pnpm typecheck` fail with
    // "tsc: not found". Force a dev env for the verify subprocess only.
    // pnpm shells out to corepack, which needs a WRITABLE cache home. The forge's
    // curated env sets HOME=/home/brokk but NOT COREPACK_HOME, so corepack falls back
    // to `/.cache/node/corepack` → EACCES on the read-only root (the same failure the
    // preview spawn fixes in preview.ts). Pin HOME + COREPACK_HOME to a writable dir.
    const home = process.env.HOME && process.env.HOME !== "/" ? process.env.HOME : "/home/brokk";
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      // CI=true makes pnpm non-interactive: without a TTY it otherwise aborts
      // (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) when it wants to purge a
      // node_modules built with different settings, instead of just doing it.
      env: {
        ...process.env,
        NODE_ENV: "development",
        CI: "true",
        HOME: home,
        COREPACK_HOME: `${home}/.cache/corepack`,
      },
      maxBuffer: 1024 * 1024 * 64,
      timeout: 8 * 60 * 1000,
    });
    return { ok: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (err: any) {
    const out = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}\n${err?.message ?? err}`.trim();
    return { ok: false, output: out };
  }
}

/** Render the live-acceptance receipt for a PR body. The screenshot is a base64
 *  data URL (GitHub won't render it inline without a host), so it lives in the
 *  Brokk run-log; here we surface the pass/fail verdict + the check's output. */
function acceptanceBlock(receipt: AcceptanceReceipt | null): string[] {
  if (!receipt?.ran) return [];
  return [
    `**Acceptance (live):** ${receipt.ok ? "✅ met" : "❌ not met"}` +
      (receipt.screenshot ? " · 📷 screenshot in the Brokk run-log" : ""),
    "",
    "<details><summary>acceptance check output</summary>",
    "",
    "```",
    receipt.output.slice(-2000) || "(no output)",
    "```",
    "",
    "</details>",
    "",
  ];
}

function prBody(task: Task, verify: VerifyResult | null, receipt?: AcceptanceReceipt | null): string {
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
  lines.push(...acceptanceBlock(receipt ?? null));
  lines.push("---", `🔨 Forged by **Brokk** · task \`${task.id}\``);
  return lines.join("\n");
}

/** PR body for a plan's shared feature PR (opened by the first card). Describes
 *  the feature; the individual cards land as commits on this branch. */
function planPrBody(plan: Plan, verify: VerifyResult | null, receipt?: AcceptanceReceipt | null): string {
  const lines = [plan.rationale || plan.summary, ""];
  lines.push(`**Plan:** ${plan.mode} · base \`${plan.baseBranch}\``, "");
  if (verify) {
    lines.push(`**Verify (first card):** ${verify.ok ? "✅ passed" : "❌ failed"}`, "");
  }
  lines.push(...acceptanceBlock(receipt ?? null));
  lines.push(
    "_Cards of this plan compose into this single PR; each lands as a commit on the feature branch._",
    "",
    "---",
    `🔨 Forged by **Brokk** · plan \`${plan.id}\``,
  );
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
  console.error("[forge] fatal:", err);
  process.exit(1);
});
