/**
 * PreviewSupervisor — boots, monitors, and reaps dev-preview processes.
 *
 * Runs as a separate loop alongside the forge claim loop.  The control plane
 * creates a preview row in 'starting' status (via POST /previews); the
 * supervisor picks it up here, provisions the Hauldr project, refreshes the
 * persistent worktree, starts the app, and marks it 'live'.
 *
 * Persistent worktrees: unlike forge worktrees (cleaned up after each run),
 * preview worktrees are KEPT between restarts and refreshed (fetch + reset) so
 * node_modules / build caches survive — keeping cold-start time low.
 *
 * Lifecycle: previews are persistent singletons — one `<app>-dev` per app. A
 * manual DELETE /previews/:id marks the row 'stopped'; the next tick kills the
 * local process. A dev-lane push refreshes the worktree in place via
 * refreshCheckout() (HMR reflects it) instead of restarting the server.
 *
 * Soft cutover on respin: when a live process must restart (heal N1, etc.), the
 * outgoing process keeps serving until the replacement is healthy on a new port;
 * only then do we flip the control-plane port and SIGTERM the old one.
 */
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { PREVIEW_IDLE_TTL_MS, type Preview, type Repository, type RuntimeSpec } from "@brokk/core";
import { buildDetectCtx, composeCommand, PACKAGE_MANAGERS, resolveRuntime } from "@brokk/core/runtime";
import type { RunnerConfig } from "./config.js";
import type { GhProvider } from "./git.js";
import type { DataProvider } from "./data-provider.js";

interface LivePreview {
  proc: ChildProcess;
  port: number;
  /** When the process was spawned — lets the tick tell a fresh boot settling
   *  into 'live' apart from a stale process whose row was respun to 'starting'. */
  startedAt: number;
  /** Self-heal (bundle probe). Set at boot from the resolved RuntimeSpec. */
  bundleProbe?: string;
  /** Worktree path — the Metro/transform caches to clear live during a heal. */
  wtPath: string;
  hauldrProject: string;
  branch: string;
}

/**
 * Per-app preview secrets. A preview process inherits only the runner's
 * `process.env` + the Hauldr DB vars, so app-specific secrets (e.g. the LiteLLM
 * gateway key for image generation) have nowhere to come from — the preview
 * boots keyless and silently falls back to its demo/stub path. We let each app
 * drop a `<hauldrProject>.env` file in BROKK_PREVIEW_SECRETS_DIR (mounted into
 * the runner, OUTSIDE any worktree so it survives refreshes and never leaks
 * across apps). Parsed here and merged into the spawn env. Absent dir/file →
 * empty (no behaviour change). Minimal dotenv: `KEY=value`, `#` comments,
 * optional surrounding quotes; no interpolation or multiline.
 */
export function loadAppSecrets(dir: string, project: string): Record<string, string> {
  if (!dir || !project) return {};
  let raw: string;
  try {
    raw = readFileSync(join(dir, `${project}.env`), "utf8");
  } catch {
    return {}; // absent/unreadable → no per-app secrets
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** How many trailing output lines a boot keeps to explain a death before serving. */
const TAIL_LINES = 12;

/** Keys whose VALUE is a secret and must never be shown in the Env inspector. */
const SECRET_KEY_RE =
  /(secret|token|password|passwd|jwt|service_role|_key$|apikey|api_key|credential)/i;

/** Redact an env map for display: mask secret-keyed values (keep a 4-char tail
 *  for identification) and strip the password out of any connection string, but
 *  leave URLs, modes, emails and other non-secret values legible — those are the
 *  point of the inspector (which backend the preview is wired to). */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  const mask = (v: string) => (v ? `••••${v.length > 4 ? v.slice(-4) : ""}` : v);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = SECRET_KEY_RE.test(k)
      ? mask(v)
      : v.replace(/:\/\/([^:@/]+):[^@/]+@/, (_m, user) => `://${user}:••••@`);
  }
  return out;
}

export class PreviewSupervisor {
  /** Locally-managed running preview processes keyed by preview id. */
  private readonly live = new Map<string, LivePreview>();
  /** Incoming process during soft cutover (old still in `live` until flip). */
  private readonly pending = new Map<string, LivePreview>();
  /** Previews currently in the process of being booted (fire-and-forget guard). */
  private readonly booting = new Set<string>();
  /** Ports currently in use by running preview processes. */
  private readonly usedPorts = new Set<number>();
  /** Last drift-refresh (fetch da tip) per preview id — throttles the tick. */
  private readonly lastDriftRefresh = new Map<string, number>();
  /** Last bundle-probe per preview id — throttles the self-heal check. */
  private readonly lastBundleProbe = new Map<string, number>();
  /** Consecutive broken bundle probes per preview id — a heal only fires after
   *  ≥2 so a mid-rebuild blip (which self-heals in seconds) never triggers it. */
  private readonly brokenStreak = new Map<string, number>();
  /** Heal bookkeeping keyed by `${previewId}:${sha}` — a clean-cache restart and
   *  a code heal each fire at most ONCE per broken commit, never in a loop. */
  private readonly restartedShas = new Set<string>();
  private readonly codeHealedShas = new Set<string>();
  /** Master switch for bundle self-heal (BROKK_PREVIEW_AUTOHEAL=0 disables). */
  private readonly autoheal = process.env.BROKK_PREVIEW_AUTOHEAL !== "0";

  constructor(
    private readonly cfg: RunnerConfig,
    private readonly git: GhProvider,
    /** The data-backend seam (ADR 0027 §3.2): hauldr in the CCL fleet,
     *  passthrough when no provider is configured. */
    private readonly data: DataProvider,
  ) {}

  // ── Main loop ───────────────────────────────────────────────────────────────

  /** Run until `stopping()` returns true.  Intended to run concurrently with
   *  the forge claim loop via `void supervisor.run(...)`. */
  async run(stopping: () => boolean): Promise<void> {
    console.log("[preview-supervisor] starting");

    // Reconcile orphaned previews from a previous runner instance
    await this.reconcileOnStartup().catch((err) =>
      console.error("[preview-supervisor] startup reconcile error:", err),
    );

    while (!stopping()) {
      await this.tick().catch((err) =>
        console.error("[preview-supervisor] tick error:", err),
      );
      await sleep(this.cfg.pollIntervalMs);
    }

    // Graceful shutdown: SIGTERM every managed process
    for (const [id, lp] of this.live) {
      console.log(`[preview-supervisor] shutdown: killing ${id}`);
      this.killAndClean(id, lp);
    }
    console.log("[preview-supervisor] stopped");
  }

  // ── Refresh-on-land ─────────────────────────────────────────────────────────

  /** ADR 0017: refresh the persistent `<app>_dev` worktree to the branch tip so the
   *  live `next dev` HMR picks up what a dev-lane card just pushed (replaces the old
   *  respin). Deliberately a LIGHT fetch + `git reset --hard` on the EXISTING
   *  worktree — NOT persistentCheckout, whose worktree-add would race the running
   *  dev server. No-op when the worktree doesn't exist yet (its next boot creates it
   *  fresh at the tip). Best-effort: never throws, and never kills the dev-server
   *  process (HMR reacts to the changed files on its own). */
  async refreshCheckout(hauldrProject: string, branch: string): Promise<string | null> {
    // Serialized per worktree: the tick's drift refresh and the card flow's direct
    // call can overlap, and a reset racing an in-flight `pnpm install` would rip
    // node_modules out from under it. Late callers just join the in-flight refresh.
    const inflight = this.refreshing.get(hauldrProject);
    if (inflight) return inflight;
    const p = this.doRefreshCheckout(hauldrProject, branch).finally(() => {
      this.refreshing.delete(hauldrProject);
    });
    this.refreshing.set(hauldrProject, p);
    return p;
  }

  private readonly refreshing = new Map<string, Promise<string | null>>();

  private async doRefreshCheckout(hauldrProject: string, branch: string): Promise<string | null> {
    // Same path convention as GhProvider.persistentCheckout(name=<hauldrProject>):
    // <workDir>/preview-worktrees/<name>.
    const path = join(this.cfg.workDir, "preview-worktrees", hauldrProject);
    if (!existsSync(path)) return null; // no live singleton to refresh
    const run = promisify(execFile);
    try {
      // Fetch EVERY branch into remote-tracking refs — never into refs/heads/*, of
      // which <branch> is checked out in this worktree (git refuses to fetch into a
      // checked-out branch). The wide refspec is what keeps refs the agent reads —
      // `origin/main` above all — honest: this bare has no remote.origin.fetch, so a
      // narrow `refs/heads/<base>` fetch leaves every OTHER branch frozen at the
      // clone-time value forever, and an agent comparing against it answers with
      // confidence and backwards. Then hard-reset the worktree onto the tip. Skip the
      // reset when the tip didn't move, so the periodic tick refresh is a no-op
      // without mtime churn (HMR would otherwise re-trigger on identical files).
      await run("git", ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], { cwd: path });
      const head = (await run("git", ["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
      // Resolve the tip by name, NOT via FETCH_HEAD: a multi-ref fetch writes one
      // FETCH_HEAD line per branch and `rev-parse FETCH_HEAD` yields the first —
      // which is whatever branch sorted first, not <branch>.
      const fetched = (
        await run("git", ["rev-parse", `refs/remotes/origin/${branch}`], { cwd: path })
      ).stdout.trim();
      if (head === fetched) return null;
      // Live edits guard: if the worktree has uncommitted TRACKED changes (a
      // chat/dev-lane session editing it live — BROKK_LIVE_PREVIEW), a hard reset
      // would wipe the work HMR is showing. Skip; the reset lands once the editor
      // commits+pushes (clean tree). The tip advanced but we defer rather than
      // clobber. HMR keeps serving the working tree meanwhile.
      // `--untracked-files=no` is deliberate: the supervisor writes its OWN
      // untracked prepare file into the worktree (e.g. .brokk/vite.preview.config.mjs),
      // which a bare `git status --porcelain` reports as dirty — that false-positive
      // pinned the guard on forever, so a plain `git push` to dev never landed
      // (the reported bug). `git reset --hard` never touches untracked files anyway,
      // so ignoring them here is safe as well as necessary.
      const dirty = (
        await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: path })
      ).stdout.trim();
      if (dirty) {
        console.log(
          `[preview-supervisor] ${hauldrProject}: worktree dirty (live edits) — deferring reset to ${fetched.slice(0, 8)}`,
        );
        return null;
      }
      await run("git", ["reset", "--hard", "FETCH_HEAD"], { cwd: path });
      console.log(
        `[preview-supervisor] refreshed ${hauldrProject} worktree → ${branch} tip (${fetched.slice(0, 8)})`,
      );
      // A push that adds a dependency changes the lockfile; only boot installs, so
      // without this the running dev server 500s on module resolution until someone
      // installs by hand (incident: brokk-mobile-dev 2026-07-09).
      await this.installIfLockfileChanged(path, hauldrProject, head, fetched);
      return fetched;
    } catch (err) {
      console.warn(
        `[preview-supervisor] refreshCheckout ${hauldrProject} failed:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Re-run the package-manager install after a refresh whose diff touched a
   *  lockfile (any depth — monorepo lockfiles live off-root). Best-effort like the
   *  rest of the refresh path: a failed install logs and leaves the worktree as-is. */
  private async installIfLockfileChanged(
    path: string,
    hauldrProject: string,
    fromSha: string,
    toSha: string,
  ): Promise<void> {
    const run = promisify(execFile);
    try {
      const { stdout } = await run("git", ["diff", "--name-only", fromSha, toSha], { cwd: path });
      const changed = stdout.split("\n").filter(Boolean);
      const pm = Object.values(PACKAGE_MANAGERS).find((info) =>
        changed.some((f) => f === info.lockfile || f.endsWith(`/${info.lockfile}`)),
      );
      if (!pm) return;
      console.log(
        `[preview-supervisor] ${hauldrProject}: lockfile changed → ${pm.install}`,
      );
      // Same HOME/corepack pinning as boot(): the runner's env can arrive without a
      // writable HOME and corepack dies provisioning the repo-pinned pnpm.
      const home =
        process.env.HOME && process.env.HOME !== "/" ? process.env.HOME : "/home/brokk";
      await run("sh", ["-c", pm.install], {
        cwd: path,
        env: { ...process.env, HOME: home, COREPACK_HOME: `${home}/.cache/corepack` },
        timeout: 5 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      console.log(`[preview-supervisor] ${hauldrProject}: install ok`);
    } catch (err) {
      console.warn(
        `[preview-supervisor] ${hauldrProject}: install after refresh failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Startup reconciliation ──────────────────────────────────────────────────

  /** On restart, mark live/starting previews whose PID is no longer alive as
   *  stopped so they can be re-requested by the app. */
  private async reconcileOnStartup(): Promise<void> {
    const previews = await this.controlGet<Preview[]>("/previews").catch(
      () => [] as Preview[],
    );
    for (const p of previews) {
      if (p.status !== "starting" && p.status !== "live") continue;
      let dead = true;
      if (p.pid) {
        try {
          // Signal 0: no signal sent, just checks if the process exists.
          process.kill(p.pid, 0);
          dead = false; // Process is alive — we don't own it, leave as-is
        } catch {
          dead = true; // ESRCH or EPERM → treat as dead
        }
      }
      if (dead) {
        console.log(
          `[preview-supervisor] orphan ${p.id} (pid=${p.pid ?? "none"}) → stopped`,
        );
        await this.controlPatch(`/previews/${p.id}`, {
          status: "stopped",
          pid: null,
          port: null,
        }).catch(() => {});
      }
    }
  }

  // ── Tick ────────────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const previews = await this.controlGet<Preview[]>("/previews");

    for (const p of previews) {
      switch (p.status) {
        case "starting": {
          if (this.booting.has(p.id) || this.pending.has(p.id)) break;
          const stale = this.live.get(p.id);
          if (stale) {
            // Fresh boot still settling (<60s) — leave it; its live patch is in flight.
            if (Date.now() - stale.startedAt < 60_000) break;
            // Soft cutover: keep stale serving until the replacement is healthy.
            console.log(
              `[preview-supervisor] ${p.subdomain}: soft-respin — keeping :${stale.port} until replacement is healthy`,
            );
          }
          this.booting.add(p.id);
          void this.boot(p, { retain: stale ?? undefined })
            .catch((err) => {
              console.error(`[preview-supervisor] boot ${p.id} error:`, err);
              const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
              // Soft-respin failed: restore live on the retained process if any.
              if (stale && this.live.get(p.id)?.proc === stale.proc) {
                void this.controlPatch(`/previews/${p.id}`, {
                  status: "live",
                  detail: null,
                  pid: stale.proc.pid ?? null,
                  port: stale.port,
                }).catch(() => {});
              } else {
                void this.controlPatch(`/previews/${p.id}`, { status: "failed", detail }).catch(
                  () => {},
                );
              }
            })
            .finally(() => {
              this.booting.delete(p.id);
            });
          break;
        }

        case "live": {
          const lp = this.live.get(p.id);
          if (!lp) break; // not managed by this instance

          // Process exited on its own
          if (lp.proc.exitCode !== null || lp.proc.killed) {
            console.log(
              `[preview-supervisor] ${p.subdomain} exited (code=${lp.proc.exitCode})`,
            );
            this.killAndClean(p.id, lp);
            await this.controlPatch(`/previews/${p.id}`, {
              status: "stopped",
              pid: null,
              port: null,
            }).catch(() => {});
            break;
          }

          // Idle reaper: a live preview with no activity — no UI heartbeat, no
          // respin, no push — past the TTL goes back to rest, so a dev docker
          // never runs unattended. Waking is cheap: re-entering the Brokk screen
          // or hitting the preview URL restarts the same slot.
          const idleMs = Date.now() - new Date(p.lastActivityAt).getTime();
          if (idleMs > PREVIEW_IDLE_TTL_MS) {
            console.log(
              `[preview-supervisor] ${p.subdomain}: idle ${Math.round(idleMs / 60000)}min → resting`,
            );
            this.killAndClean(p.id, lp);
            await this.controlPatch(`/previews/${p.id}`, {
              status: "stopped",
              pid: null,
              port: null,
            }).catch(() => {});
            break;
          }

          // Drift refresh: pull the branch tip into the worktree so pushes that
          // DON'T come from the dev-lane card flow (Sindri chat, a human `git
          // push`) also land in the running HMR server. The card flow still
          // calls refreshCheckout() directly for the instant path; this is the
          // ≤60s backstop for everything else. Throttled per preview — the tick
          // itself runs every few seconds.
          const last = this.lastDriftRefresh.get(p.id) ?? 0;
          if (Date.now() - last >= 60_000) {
            this.lastDriftRefresh.set(p.id, Date.now());
            void this.refreshCheckout(p.hauldrProject, p.branch).then((sha) => {
              if (!sha) return;
              return this.controlPatch(`/previews/${p.id}`, {
                commitSha: sha,
                builtAt: new Date().toISOString(),
              }).catch(() => {});
            });
          }

          // Bundle self-heal: for stacks that declare a bundleProbe (Expo/Metro),
          // periodically check the JS bundle actually compiles — the server can
          // answer /status while the bundle fails to resolve (the "./index" /
          // UnableToResolveError class that leaves the phone on a red screen).
          // Throttled + streak-gated so a mid-rebuild blip never triggers a heal.
          if (lp.bundleProbe && this.autoheal) {
            const lastProbe = this.lastBundleProbe.get(p.id) ?? 0;
            if (Date.now() - lastProbe >= 20_000) {
              this.lastBundleProbe.set(p.id, Date.now());
              void this.verifyAndHealBundle(p, lp).catch((err) =>
                console.warn(`[preview-supervisor] bundle heal ${p.subdomain} errored:`, err),
              );
            }
          }
          break;
        }

        case "stopped":
        case "failed": {
          // Manual stop (DELETE /previews/:id) or external failure → kill
          const lp = this.live.get(p.id);
          if (lp) {
            console.log(
              `[preview-supervisor] ${p.subdomain} marked ${p.status}, killing`,
            );
            this.killAndClean(p.id, lp);
          }
          break;
        }
      }
    }
  }

  // ── Boot ────────────────────────────────────────────────────────────────────

  private async boot(
    preview: Preview,
    opts?: { retain?: LivePreview },
  ): Promise<void> {
    const retain = opts?.retain;
    console.log(
      `[preview-supervisor] booting ${preview.subdomain} (${preview.id})` +
        (retain ? ` soft-over :${retain.port}` : ""),
    );

    // Phase stopwatch. There was NO duration instrumentation here, so "why is a
    // wake slow?" could only be guessed at — and the most expensive phase
    // (install) is invisible because it's concatenated into the dev command's
    // `sh -c`, inside the spawn. `ready` therefore covers install + first
    // compile together until that gets split out.
    const bootStart = Date.now();
    let phaseMark = bootStart;
    const phases: Record<string, number> = {};
    const phase = (name: string): void => {
      const now = Date.now();
      phases[name] = now - phaseMark;
      phaseMark = now;
    };
    const phaseSummary = (): string =>
      Object.entries(phases)
        .map(([k, ms]) => `${k}=${(ms / 1000).toFixed(1)}s`)
        .join(" ") + ` total=${((Date.now() - bootStart) / 1000).toFixed(1)}s`;

    // Resolve project → repository from the control plane
    const project = await this.controlGet<{
      id: string;
      repositoryId: string;
      name: string;
      baseBranch: string;
      runtime?: RuntimeSpec | null;
    }>(`/projects/${preview.projectId}`);
    const repo = await this.controlGet<Repository>(
      `/repositories/${project.repositoryId}`,
    );

    // Provision (or fetch) the preview's data backend via the provider seam.
    await this.controlPatch(`/previews/${preview.id}`, {
      detail: "Provisionando banco de dados…",
    }).catch(() => {});
    let dataEnv: Record<string, string> = {};
    let migrateEnv: Record<string, string> | undefined;
    try {
      const provided = await this.data.ensureEnv(preview.hauldrProject);
      dataEnv = provided.env;
      migrateEnv = provided.migrateEnv;
      console.log(
        `[preview-supervisor] data backend "${preview.hauldrProject}" ready (${this.data.name})`,
      );
    } catch (err) {
      // Log and continue — some apps don't need a DB (static builds, etc.)
      console.warn(
        `[preview-supervisor] ${this.data.name} provisioning failed for "${preview.hauldrProject}":`,
        err,
      );
    }
    phase("db");

    // Resolve the working directory. The forge preview runs `next dev` (HMR) — ADR
    // 0017 moved the real `next build` to the Coolify dev-build; the forge preview is
    // the fast HMR loop only. Every preview is the app singleton: refresh (or create)
    // the persistent worktree, one per app keyed by the <app>_dev slug, tracking the
    // branch tip so node_modules / .next cache survive restarts.
    await this.controlPatch(`/previews/${preview.id}`, {
      detail: "Preparando o código…",
    }).catch(() => {});
    const { path: wtPath } = await this.git.persistentCheckout({
      repo,
      branch: preview.branch,
      name: preview.hauldrProject,
    });
    phase("checkout");

    // Stamp the sha this boot serves (the checkout's HEAD) — it's what turns
    // this row into a *deploy* for Heimdall's fleet view (which drops commitless
    // previews as provisioning noise). Best-effort: a dev-mode workDir mid-setup
    // just skips the stamp until its next boot.
    const commitSha = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: wtPath })
      .then((r) => r.stdout.trim())
      .catch(() => null);
    if (commitSha) {
      await this.controlPatch(`/previews/${preview.id}`, {
        commitSha,
        builtAt: new Date().toISOString(),
      }).catch(() => {});
    }

    // Sleipnir: resolve HOW to run this checkout. Pinned spec (decided at connect
    // by Huginn) → canonical Next fast-path → unsupported. No LLM at boot — the
    // decision was made once at connect. A non-supported runtime is a CLEAN stop
    // (status 'unsupported' + reason), not a 90s next-dev-then-crash 'failed'.
    const spec = await resolveRuntime(project.runtime ?? null, buildDetectCtx(wtPath));
    if (!spec.supported) {
      const detail = spec.reason ?? "no supported runtime detected";
      console.log(`[preview-supervisor] ${preview.subdomain}: unsupported — ${detail}`);
      await this.controlPatch(`/previews/${preview.id}`, { status: "unsupported", detail });
      return;
    }

    // Schema-as-code parity with prod: if the checkout ships db/migrations + the
    // migrate client, apply them to this preview's Hauldr project BEFORE boot —
    // mirroring what the prod Docker entrypoint does on deploy. Idempotent
    // (tracked in _hauldr_migrations) so only new files run. Dev logs-and-continues
    // where prod aborts: a broken migration surfaces in the preview, not silently.
    const migrateScript = join(wtPath, "scripts/hauldr-migrate.mjs");
    if (migrateEnv && existsSync(migrateScript)) {
      await this.controlPatch(`/previews/${preview.id}`, {
        detail: "Aplicando migrações do banco…",
      }).catch(() => {});
      try {
        const { stdout } = await promisify(execFile)(
          "node",
          ["scripts/hauldr-migrate.mjs"],
          {
            cwd: wtPath,
            env: { ...process.env, ...migrateEnv },
          },
        );
        console.log(
          `[preview-supervisor] ${preview.subdomain}: migrations applied\n${stdout.trim()}`,
        );
      } catch (err) {
        console.error(
          `[preview-supervisor] ${preview.subdomain}: hauldr-migrate FAILED (booting anyway):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    phase("migrate");

    const port = this.allocatePort();
    // ADR 0017: the forge preview is always the HMR loop (`next dev`) — the real
    // `next build` gate now lives in the Coolify dev-build. Command comes from the
    // resolved RuntimeSpec's "dev" preset (Sleipnir); BROKK_PREVIEW_DEV_CMD stays as
    // an explicit ops override when set.
    const override = process.env.BROKK_PREVIEW_DEV_CMD;
    const baseCmd =
      override && override.trim() ? override : composeCommand(spec, "dev");
    const cmd = this.expandCmd(baseCmd, port);
    console.log(
      `[preview-supervisor] ${preview.subdomain}: runtime=${spec.label} (${spec.source})`,
    );

    // Per-app secrets (e.g. the LiteLLM gateway key) — merged AFTER the inherited
    // env so they win, but BEFORE PORT/NODE_ENV so a stray entry can't clobber
    // those. Kept outside the worktree, so unlike a `.env.local` they survive the
    // worktree refresh and never bleed into other apps' previews.
    const appSecrets = loadAppSecrets(this.cfg.previewSecretsDir, preview.hauldrProject);
    if (Object.keys(appSecrets).length) {
      console.log(
        `[preview-supervisor] ${preview.subdomain}: merged ${Object.keys(appSecrets).length} app secret(s) from ${preview.hauldrProject}.env`,
      );
    }

    // pnpm shells out to corepack to provision the repo-pinned pnpm, and corepack
    // needs a WRITABLE HOME for its download cache. The forge's runtime env can
    // arrive without HOME (Coolify injects a curated env), so corepack falls back
    // to `/.cache` → `EACCES: mkdir '/.cache/node/corepack'` and the build dies
    // "before serving". Pin HOME (and the corepack cache) to a writable dir so
    // `pnpm install` can always provision its package manager.
    const home = process.env.HOME && process.env.HOME !== "/" ? process.env.HOME : "/home/brokk";
    // Runtime-declared env (spec.env — e.g. Expo's EXPO_PACKAGER_PROXY_URL). The
    // `$PUBLIC_URL` placeholder expands to the preview's public URL here, so the
    // provider stays generic and the supervisor stays framework-blind.
    const specEnv = Object.fromEntries(
      Object.entries(spec.env ?? {}).map(([k, v]) => [
        k,
        v.replaceAll("$PUBLIC_URL", preview.url ?? ""),
      ]),
    );
    // The APP-relevant env: data backend + per-app secrets + runtime-declared
    // env + PORT/NODE_ENV. Curated (NOT the forge's own process.env) so it's both
    // what the app is wired to AND what the Env inspector reports — the forge's
    // internal secrets never leak into the snapshot.
    const appEnv: Record<string, string> = {
      ...dataEnv,
      ...appSecrets,
      ...specEnv,
      PORT: String(port),
      // The forge preview always runs the HMR dev server, so development mode
      // across the board (ADR 0017 — the production build lives in the dev-build).
      NODE_ENV: "development",
    };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...appEnv,
      HOME: home,
      COREPACK_HOME: `${home}/.cache/corepack`,
      // A preview boots headless (no TTY). When a leftover node_modules is
      // incompatible with the current pnpm/store, `pnpm install` wants to purge
      // it and PROMPT — which aborts non-interactively with
      // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY and kills the boot (took down
      // the whole preview lane). CI=true lets pnpm purge + reinstall silently.
      CI: "true",
    };

    // Report a redacted snapshot of what we loaded, so the preview bar's Env
    // inspector can show an operator what this dev preview is wired to (e.g. that
    // its backend URLs point at the isolated <app>_dev Hauldr project, never
    // prod). Secret-looking values are masked; URLs/modes stay legible. The keys
    // that matter for onboarding — VITE_HAULDR_URL, DATA_API_URL, HAULDR_GOTRUE_URL
    // — are non-secret, so they read in clear. Fire-and-forget.
    void this.controlPatch(`/previews/${preview.id}`, { loadedEnv: redactEnv(appEnv) }).catch(
      () => {},
    );

    console.log(
      `[preview-supervisor] ${preview.subdomain}: port=${port} cwd=${wtPath}`,
    );
    console.log(`[preview-supervisor] ${preview.subdomain}: cmd=${cmd}`);

    // Materialise runtime-declared prepare files into the checkout before boot
    // (e.g. Vite's allowedHosts wrapper config). Framework-agnostic: the forge
    // just writes what the spec declares, under appRoot, then the dev command
    // opts them in. Untracked, so `reset --hard` on refresh leaves them in place.
    const appDir = spec.appRoot && spec.appRoot !== "." ? join(wtPath, spec.appRoot) : wtPath;
    for (const f of spec.prepareFiles ?? []) {
      const dest = join(appDir, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.contents);
      console.log(`[preview-supervisor] ${preview.subdomain}: wrote prepare file ${f.path}`);
    }

    const proc = spawn("sh", ["-c", cmd], {
      cwd: wtPath,
      env,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tag = `[preview:${preview.subdomain}]`;
    // Keep the tail of the child's output. The dev command is `install && dev`, so a
    // boot dies before serving either because the dev server crashed OR because the
    // install failed and `&&` short-circuited — the dev server never ran at all.
    // "exited before serving" alone reads identically for both, which sent an
    // operator hunting a Vite crash that had never happened (the install was exiting
    // 1 on ERR_PNPM_IGNORED_BUILDS). Echo the last lines back on failure so the
    // reason is in the log next to the verdict.
    const tail: string[] = [];
    const keepTail = (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        const s = line.trim();
        if (!s) continue;
        tail.push(s);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    };
    proc.stdout?.on("data", (d: Buffer) => {
      keepTail(d);
      process.stdout.write(`${tag} ${d}`);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      keepTail(d);
      process.stderr.write(`${tag} ${d}`);
    });

    // Register locally BEFORE the first await so concurrent ticks don't
    // double-boot. Soft cutover: keep the outgoing process in `live` and park
    // the incoming one in `pending` until health flips the pointer.
    const entry: LivePreview = {
      proc,
      port,
      startedAt: Date.now(),
      bundleProbe: spec.bundleProbe,
      wtPath,
      hauldrProject: preview.hauldrProject,
      branch: preview.branch,
    };
    if (retain) {
      this.pending.set(preview.id, entry);
    } else {
      this.live.set(preview.id, entry);
    }

    // Don't flip to 'live' the instant the process spawns — that's why the iframe
    // used to render a broken page while `pnpm install` + the first compile were
    // still running (status was 'live' but nothing was listening yet). Hold
    // 'starting' with a phase until the server actually answers, so the pane
    // shows the spinner through install/compile and the iframe only appears when
    // there's really something to render. Soft cutover keeps the OLD port on the
    // row so the gateway can keep serving until we flip.
    await this.controlPatch(`/previews/${preview.id}`, {
      detail: retain
        ? "Reiniciando preview (o atual segue no ar)…"
        : "Instalando dependências e compilando…",
      // Keep serving the retained port while status is starting (gateway accepts it).
      ...(retain ? { port: retain.port, pid: retain.proc.pid ?? null } : {}),
    }).catch(() => {});

    const outcome = await this.waitHealthy(preview, proc, port, spec.health ?? "/");
    if (outcome === "exited") {
      console.log(
        `[preview-supervisor] ${preview.subdomain}: exited before serving (exit=${proc.exitCode})`,
      );
      for (const l of tail) {
        console.log(`[preview-supervisor] ${preview.subdomain}:   | ${l}`);
      }
      this.pending.delete(preview.id);
      this.usedPorts.delete(port);
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      if (retain && this.live.get(preview.id)?.proc === retain.proc) {
        // Soft-respin failed — keep the old process as the live preview.
        await this.controlPatch(`/previews/${preview.id}`, {
          status: "live",
          detail: null,
          pid: retain.proc.pid ?? null,
          port: retain.port,
        }).catch(() => {});
        return;
      }
      const lp = this.live.get(preview.id);
      if (lp && lp.proc === proc) this.killAndClean(preview.id, lp);
      await this.controlPatch(`/previews/${preview.id}`, {
        status: "failed",
        detail: tail.length
          ? `Saiu antes de servir (exit=${proc.exitCode}): ${tail[tail.length - 1]!.slice(0, 200)}`
          : "Build/start falhou antes de servir — ver os logs do preview.",
        pid: null,
        port: null,
      }).catch(() => {});
      return;
    }

    // Flip: new process is healthy — point traffic, then retire the old one.
    this.live.set(preview.id, entry);
    this.pending.delete(preview.id);
    await this.controlPatch(`/previews/${preview.id}`, {
      status: "live",
      detail: null,
      pid: proc.pid ?? null,
      port,
    });

    if (retain && retain.proc !== proc) {
      console.log(
        `[preview-supervisor] ${preview.subdomain}: cutover :${retain.port} → :${port} (retiring old pid=${retain.proc.pid})`,
      );
      this.usedPorts.delete(retain.port);
      try {
        retain.proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }

    phase("ready");
    console.log(
      `[preview-supervisor] ${preview.subdomain} live on :${port}` +
        ` (pid=${proc.pid}, health=${outcome})`,
    );
    // `ready` = spawn → first successful health poll, so it still bundles the
    // install with the first compile (they share one `sh -c`). Splitting the
    // install out makes this number mean "compile" alone.
    console.log(`[preview-supervisor] ${preview.subdomain}: fases ${phaseSummary()}`);

    // Auto-stop when the process exits unexpectedly
    proc.on("exit", (code, signal) => {
      console.log(
        `[preview-supervisor] ${preview.subdomain} exited` +
          ` (code=${code}, signal=${signal})`,
      );
      const lp = this.live.get(preview.id);
      if (lp) {
        // Only clean up if this is still the registered process (not a restart)
        if (lp.proc === proc) {
          this.killAndClean(preview.id, lp);
          void this.controlPatch(`/previews/${preview.id}`, {
            status: "stopped",
            pid: null,
            port: null,
          }).catch(() => {});
        }
      }
    });
  }

  // ── Bundle self-heal ──────────────────────────────────────────────────────────

  /** Probe the JS bundle; on a genuine (streak-confirmed) compile failure, heal:
   *  N1 = restart the dev server with its caches cleared (fixes the stale-graph /
   *  reset-race class); N2 = if it STILL breaks on the same commit, hand the Metro
   *  error to the app's newest active Sindri session to fix the code. Bounded: each
   *  step fires at most once per (preview, commit). */
  private async verifyAndHealBundle(p: Preview, lp: LivePreview): Promise<void> {
    const err = await this.probeBundle(lp.port, lp.bundleProbe!);
    const streakKey = p.id;
    if (!err) {
      this.brokenStreak.delete(streakKey);
      return;
    }
    // Require two consecutive broken probes (~40s) so a mid-rebuild blip — which
    // Metro recovers from on its own — never escalates to a restart.
    const streak = (this.brokenStreak.get(streakKey) ?? 0) + 1;
    this.brokenStreak.set(streakKey, streak);
    if (streak < 2) {
      console.log(`[preview-supervisor] ${p.subdomain}: bundle broken (probe ${streak}/2), watching`);
      return;
    }

    const sha = p.commitSha ?? "unknown";
    const restartKey = `${p.id}:${sha}`;

    // N1 — clean-cache soft-respin. Clear Metro's transform caches in the worktree
    // and drop the row to 'starting' WITHOUT killing the live process — the tick
    // soft-boots a replacement on a new port and only then retires this one.
    if (!this.restartedShas.has(restartKey)) {
      this.restartedShas.add(restartKey);
      console.log(
        `[preview-supervisor] ${p.subdomain}: bundle broken on ${sha.slice(0, 8)} — clean-cache soft-respin (N1)\n  ${err.slice(0, 200)}`,
      );
      await this.clearMetroCache(lp.wtPath);
      this.brokenStreak.delete(streakKey);
      await this.controlPatch(`/previews/${p.id}`, {
        status: "starting",
        detail: "Reiniciando preview (mantendo o atual no ar)…",
        // Keep port/pid so the gateway keeps routing the outgoing process.
        port: lp.port,
        pid: lp.proc.pid ?? null,
      });
      return;
    }

    // N2 — the clean restart didn't fix it: this is a real code error. Hand it to
    // the app's Sindri agent to fix + publish. Once per broken commit; the API
    // finds the newest active session and refuses if none/one is already running.
    if (!this.codeHealedShas.has(restartKey)) {
      this.codeHealedShas.add(restartKey);
      console.log(
        `[preview-supervisor] ${p.subdomain}: still broken after restart — asking Sindri to fix (N2)`,
      );
      await this.controlPatch(`/previews/${p.id}`, {
        status: "failed",
        detail: `Bundle não compila:\n${err.slice(0, 260)}`,
      }).catch(() => {});
      await this.controlPost(`/previews/${p.id}/heal`, { error: err.slice(0, 1500) }).catch((e) =>
        console.warn(`[preview-supervisor] ${p.subdomain}: heal handoff failed:`, e),
      );
    }
  }

  /** Fetch the bundle probe; return null if it compiles, else the Metro error
   *  text. Metro answers a broken bundle with a JSON body carrying a `type` ending
   *  in "Error" (and a non-2xx status); a healthy bundle is 200 JS. */
  private async probeBundle(port: number, probePath: string): Promise<string | null> {
    const url = `http://127.0.0.1:${port}${probePath}`;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15_000);
      const res = await fetch(url, { signal: ac.signal });
      const ct = res.headers.get("content-type") ?? "";
      if (res.ok && !ct.includes("application/json")) return null; // 200 JS = healthy
      const body = await res.text();
      try {
        const j = JSON.parse(body) as { type?: string; message?: string };
        if (typeof j.type === "string" && /Error$/.test(j.type)) {
          return `${j.type}: ${j.message ?? ""}`.trim();
        }
      } catch {
        /* not JSON */
      }
      // Non-2xx without a recognizable Metro error object — treat as broken but
      // report the status so the streak logic can still recover on a blip.
      return res.ok ? null : `bundle probe HTTP ${res.status}`;
    } catch (e) {
      // A timeout/refused mid-restart is not a compile error — don't escalate.
      return e instanceof Error && e.name === "AbortError" ? null : null;
    }
  }

  /** Remove Metro/Expo transform caches under the worktree so the next boot
   *  compiles from clean state (the `-c` equivalent). Best-effort. */
  private async clearMetroCache(wtPath: string): Promise<void> {
    const targets = ["node_modules/.cache", ".expo", ".metro-cache"];
    await Promise.all(
      targets.map((rel) =>
        promisify(execFile)("rm", ["-rf", join(wtPath, rel)]).catch(() => {}),
      ),
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Poll a freshly-spawned preview until it answers on its health path (any HTTP
   *  status = the port is bound and serving), the process exits, or the budget
   *  runs out. Returns 'ready' | 'exited' | 'timeout'. A timeout still boots the
   *  preview (degraded) rather than stranding it in 'starting' forever — a slow
   *  first compile shouldn't read as a failure. */
  private async waitHealthy(
    preview: Preview,
    proc: ChildProcess,
    port: number,
    healthPath: string,
  ): Promise<"ready" | "exited" | "timeout"> {
    const path = healthPath.startsWith("/") ? healthPath : `/${healthPath}`;
    const url = `http://127.0.0.1:${port}${path}`;
    const deadline = Date.now() + this.cfg.previewHealthTimeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.killed) return "exited";
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 3000);
        const res = await fetch(url, { signal: ac.signal, redirect: "manual" });
        clearTimeout(t);
        if (res.status > 0) return "ready"; // any response = listening
      } catch {
        /* not up yet — the dev server hasn't bound the port */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log(
      `[preview-supervisor] ${preview.subdomain}: health timeout, booting degraded`,
    );
    return "timeout";
  }

  /** Substitute $PORT / ${PORT} in the preview command. */
  private expandCmd(cmd: string, port: number): string {
    return cmd.replace(/\$PORT|\$\{PORT\}/g, String(port));
  }

  /** Pick the next free port in [previewPortMin, previewPortMax]. */
  private allocatePort(): number {
    for (let p = this.cfg.previewPortMin; p <= this.cfg.previewPortMax; p++) {
      if (!this.usedPorts.has(p)) {
        this.usedPorts.add(p);
        return p;
      }
    }
    throw new Error(
      `[preview-supervisor] no free ports in range` +
        ` ${this.cfg.previewPortMin}–${this.cfg.previewPortMax}`,
    );
  }

  /** Send SIGTERM to the process and remove it from local state. */
  private killAndClean(id: string, lp: LivePreview): void {
    this.live.delete(id);
    this.usedPorts.delete(lp.port);
    try {
      lp.proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }

  // ── Control-plane HTTP ──────────────────────────────────────────────────────

  private async controlGet<T>(path: string): Promise<T> {
    const res = await fetch(`${this.cfg.controlUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.cfg.runnerSecret}` },
    });
    if (!res.ok) {
      throw new Error(
        `[preview-supervisor] GET ${path} → ${res.status} ${await res.text().catch(() => "")}`.trim(),
      );
    }
    return (await res.json()) as T;
  }

  private async controlPatch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.controlUrl}${path}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.cfg.runnerSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `[preview-supervisor] PATCH ${path} → ${res.status} ${await res.text().catch(() => "")}`.trim(),
      );
    }
    return (await res.json()) as T;
  }

  private async controlPost<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.controlUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.runnerSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `[preview-supervisor] POST ${path} → ${res.status} ${await res.text().catch(() => "")}`.trim(),
      );
    }
    return (await res.json()) as T;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
