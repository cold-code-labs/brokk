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
 */
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Preview, Repository, RuntimeSpec } from "@brokk/core";
import { buildDetectCtx, composeCommand, resolveRuntime } from "@brokk/runtime";
import type { RunnerConfig } from "./config.js";
import type { GhProvider } from "./git.js";
import type { HauldrClient } from "./hauldr.js";

interface LivePreview {
  proc: ChildProcess;
  port: number;
  /** When the process was spawned — lets the tick tell a fresh boot settling
   *  into 'live' apart from a stale process whose row was respun to 'starting'. */
  startedAt: number;
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

export class PreviewSupervisor {
  /** Locally-managed running preview processes keyed by preview id. */
  private readonly live = new Map<string, LivePreview>();
  /** Previews currently in the process of being booted (fire-and-forget guard). */
  private readonly booting = new Set<string>();
  /** Ports currently in use by running preview processes. */
  private readonly usedPorts = new Set<number>();

  constructor(
    private readonly cfg: RunnerConfig,
    private readonly git: GhProvider,
    /** Null when HAULDR_CONTROL_URL is not set — Hauldr provisioning is skipped. */
    private readonly hauldr: HauldrClient | null,
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
  async refreshCheckout(hauldrProject: string, branch: string): Promise<void> {
    // Same path convention as GhProvider.persistentCheckout(name=<hauldrProject>):
    // <workDir>/preview-worktrees/<name>.
    const path = join(this.cfg.workDir, "preview-worktrees", hauldrProject);
    if (!existsSync(path)) return; // no live singleton to refresh
    const run = promisify(execFile);
    try {
      // Fetch the branch to FETCH_HEAD only — never into refs/heads/<branch>, which
      // is checked out in this worktree (git refuses to fetch into a checked-out
      // branch). Then hard-reset the worktree onto it. Mirrors persistentCheckout's
      // refresh, minus the racy worktree-add.
      await run("git", ["fetch", "origin", `refs/heads/${branch}`], { cwd: path });
      await run("git", ["reset", "--hard", "FETCH_HEAD"], { cwd: path });
      console.log(
        `[preview-supervisor] refreshed ${hauldrProject} worktree → ${branch} tip`,
      );
    } catch (err) {
      console.warn(
        `[preview-supervisor] refreshCheckout ${hauldrProject} failed:`,
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
          if (this.booting.has(p.id)) break;
          const stale = this.live.get(p.id);
          if (stale) {
            // A 'starting' row with a registered process = a respin (push
            // rebuild / external stop→start) landed between ticks. Retire the
            // old process and fall through to a fresh boot — breaking here
            // wedged the slot forever ('starting' + old proc serving). Guard:
            // a just-spawned proc (<60s) is a fresh boot whose 'live' patch
            // simply hasn't landed in this tick's snapshot yet — leave it.
            if (Date.now() - stale.startedAt < 60_000) break;
            console.log(
              `[preview-supervisor] ${p.subdomain}: respin — retiring the old process (pid=${stale.proc.pid})`,
            );
            this.killAndClean(p.id, stale);
          }
          this.booting.add(p.id);
          void this.boot(p)
            .catch((err) => {
              console.error(`[preview-supervisor] boot ${p.id} error:`, err);
              // Keep the reason on the row: a permanent cause (e.g. the branch
              // was deleted — "couldn't find remote ref") must read as a hard
              // 'failed', not silently retry forever.
              const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
              void this.controlPatch(`/previews/${p.id}`, { status: "failed", detail }).catch(
                () => {},
              );
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

  private async boot(preview: Preview): Promise<void> {
    console.log(
      `[preview-supervisor] booting ${preview.subdomain} (${preview.id})`,
    );

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

    // Provision (or fetch) the Hauldr dev-DB for this preview
    await this.controlPatch(`/previews/${preview.id}`, {
      detail: "Provisionando banco de dados…",
    }).catch(() => {});
    let hauldrEnv: Record<string, string> = {};
    let migrateToken = "";
    if (this.hauldr) {
      try {
        const hp = await this.hauldr.ensureProject(preview.hauldrProject);
        migrateToken = hp.migrateToken;
        // Inject the full set of Supabase-compatible env vars so any Supabase /
        // Hauldr client works out of the box.
        hauldrEnv = {
          DATABASE_URL: hp.dbUrl,
          DIRECT_URL: hp.dbUrl, // Prisma direct connection alias
          SUPABASE_URL: hp.gotrueUrl,
          NEXT_PUBLIC_SUPABASE_URL: hp.gotrueUrl,
          SUPABASE_SERVICE_ROLE_KEY: hp.jwtSecret,
          SUPABASE_ANON_KEY: hp.jwtSecret,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: hp.jwtSecret,
          SUPABASE_JWT_SECRET: hp.jwtSecret,
          POSTGREST_URL: hp.postgrestUrl,
          // Brokk-namespaced aliases for apps that use BROKK_HAULDR_* vars
          BROKK_HAULDR_DB_URL: hp.dbUrl,
          BROKK_HAULDR_GOTRUE_URL: hp.gotrueUrl,
          BROKK_HAULDR_JWT_SECRET: hp.jwtSecret,
          BROKK_HAULDR_POSTGREST_URL: hp.postgrestUrl,
          // CCL template-light contract: it switches off stub mode only when
          // AUTH_MODE/DATA_MODE are set, and reads its own HAULDR_*/DATA_API_URL
          // vars (not the Supabase names). Without these the preview boots in
          // demo (stub) mode and never touches the Hauldr dev DB.
          AUTH_MODE: "hauldr",
          DATA_MODE: "postgrest",
          HAULDR_GOTRUE_URL: hp.gotrueUrl,
          HAULDR_JWT_SECRET: hp.jwtSecret,
          DATA_API_URL: hp.postgrestUrl,
          // Dev previews are throwaway demo environments — turn on the template's
          // one-click "Entrar como demo" login (the app gates it DEV/DEMO-only via
          // DEMO_LOGIN). We seed the matching user below so the click logs in.
          DEMO_LOGIN: "true",
          DEMO_LOGIN_EMAIL: DEMO_EMAIL,
          DEMO_LOGIN_PASSWORD: DEMO_PASSWORD,
        };
        console.log(
          `[preview-supervisor] Hauldr project "${preview.hauldrProject}" ready`,
        );
        // Seed the one-click demo user into this preview's GoTrue (idempotent),
        // so the injected DEMO_LOGIN button actually authenticates.
        await seedDemoUser(hp.gotrueUrl, hp.jwtSecret).catch((err) =>
          console.warn(
            `[preview-supervisor] demo-user seed failed for "${preview.hauldrProject}":`,
            err instanceof Error ? err.message : err,
          ),
        );
      } catch (err) {
        // Log and continue — some apps don't need a DB (static builds, etc.)
        console.warn(
          `[preview-supervisor] Hauldr provisioning failed for "${preview.hauldrProject}":`,
          err,
        );
      }
    }

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
    if (migrateToken && this.cfg.hauldrControlUrl && existsSync(migrateScript)) {
      await this.controlPatch(`/previews/${preview.id}`, {
        detail: "Aplicando migrações do banco…",
      }).catch(() => {});
      try {
        const { stdout } = await promisify(execFile)(
          "node",
          ["scripts/hauldr-migrate.mjs"],
          {
            cwd: wtPath,
            env: {
              ...process.env,
              HAULDR_CONTROL_URL: this.cfg.hauldrControlUrl,
              HAULDR_PROJECT: preview.hauldrProject,
              HAULDR_MIGRATE_TOKEN: migrateToken,
            },
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...hauldrEnv,
      ...appSecrets,
      HOME: home,
      COREPACK_HOME: `${home}/.cache/corepack`,
      PORT: String(port),
      // The forge preview always runs `next dev` (HMR), so development mode across
      // the board (ADR 0017 — the production build lives in the Coolify dev-build).
      NODE_ENV: "development",
    };

    console.log(
      `[preview-supervisor] ${preview.subdomain}: port=${port} cwd=${wtPath}`,
    );
    console.log(`[preview-supervisor] ${preview.subdomain}: cmd=${cmd}`);

    const proc = spawn("sh", ["-c", cmd], {
      cwd: wtPath,
      env,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tag = `[preview:${preview.subdomain}]`;
    proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`${tag} ${d}`));
    proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`${tag} ${d}`));

    // Register locally BEFORE the first await so concurrent ticks don't
    // double-boot (the `this.live` check in tick() gates further starts).
    this.live.set(preview.id, { proc, port, startedAt: Date.now() });

    // Don't flip to 'live' the instant the process spawns — that's why the iframe
    // used to render a broken page while `pnpm install` + the first compile were
    // still running (status was 'live' but nothing was listening yet). Hold
    // 'starting' with a phase until the server actually answers, so the pane
    // shows the spinner through install/compile and the iframe only appears when
    // there's really something to render.
    await this.controlPatch(`/previews/${preview.id}`, {
      detail: "Instalando dependências e compilando…",
    }).catch(() => {});

    const outcome = await this.waitHealthy(preview, proc, port, spec.health ?? "/");
    if (outcome === "exited") {
      // Process died during startup (install/build error). We return here BEFORE
      // the success-path `proc.on("exit")` handler is wired, so clean up + mark
      // 'failed' ourselves — otherwise the dead proc leaks in `this.live` (its
      // port too) and the row is stranded in 'starting' forever, which the fleet
      // view then mirrors as a perpetual "Starting" for a preview that never came
      // up. 'failed' is honest and still re-triggerable by a push.
      console.log(
        `[preview-supervisor] ${preview.subdomain}: exited before serving`,
      );
      const lp = this.live.get(preview.id);
      if (lp && lp.proc === proc) this.killAndClean(preview.id, lp);
      await this.controlPatch(`/previews/${preview.id}`, {
        status: "failed",
        detail: "Build/start falhou antes de servir — ver os logs do preview.",
        pid: null,
        port: null,
      }).catch(() => {});
      return;
    }

    // Update the control plane: live + pid + port + expiresAt (runner-defined TTL).
    // Stamp readyAt = now: the build just finished (the server answered health).
    // Paired with builtAt (stamped after checkout) this is the build's duration —
    // what Heimdall's fleet feed renders as "Xm Ys", same as a prod deploy.
    const expiresAt = new Date(Date.now() + this.cfg.previewTtlMs).toISOString();
    await this.controlPatch(`/previews/${preview.id}`, {
      status: "live",
      detail: null,
      readyAt: new Date().toISOString(),
      pid: proc.pid ?? null,
      port,
      expiresAt,
    });

    console.log(
      `[preview-supervisor] ${preview.subdomain} live on :${port}` +
        ` (pid=${proc.pid}, expires=${expiresAt}, health=${outcome})`,
    );

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
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── one-click demo login (dev previews only) ─────────────────────────────────
// Default credentials the CCL template's DEMO_LOGIN button signs in with. Kept
// in sync with the template defaults (config/env.ts DEMO_LOGIN_EMAIL/PASSWORD).
const DEMO_EMAIL = "demo@coldcodelabs.com";
const DEMO_PASSWORD = "snowdemo123";

/** Mint a short-lived service_role JWT (HS256) from the project's GoTrue secret,
 *  so we can call GoTrue's admin API. Server-side only — never reaches a browser. */
function mintServiceToken(jwtSecret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({
    role: "service_role",
    iss: "brokk-preview",
    iat: now,
    exp: now + 300,
  })}`;
  const sig = createHmac("sha256", jwtSecret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/** Ensure the demo user exists in a preview's GoTrue with the known demo
 *  password, via the admin API. Corrective + idempotent: creates the user, or —
 *  if it already exists (possibly with a different/older password) — resets its
 *  password and confirms its email so the one-click button always authenticates.
 *  No-op without a gotrue url + secret. */
async function seedDemoUser(gotrueUrl: string, jwtSecret: string): Promise<void> {
  if (!gotrueUrl || !jwtSecret) return;
  const base = gotrueUrl.replace(/\/+$/, "");
  const headers = {
    authorization: `Bearer ${mintServiceToken(jwtSecret)}`,
    "content-type": "application/json",
  };

  const create = await fetch(`${base}/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD, email_confirm: true }),
  });
  if (create.ok) return; // fresh user created with the demo password
  const body = await create.text().catch(() => "");
  const exists =
    create.status === 422 ||
    create.status === 409 ||
    /already|registered|exists|duplicate/i.test(body);
  if (!exists) throw new Error(`GoTrue create → ${create.status} ${body.slice(0, 160)}`.trim());

  // Already there — reset its password + confirm so the demo creds work even if
  // a prior run (or a real signup) left it with a different password.
  const list = await fetch(`${base}/admin/users?per_page=200`, { headers });
  if (!list.ok) throw new Error(`GoTrue list → ${list.status}`);
  const data = (await list.json().catch(() => ({}))) as { users?: Array<{ id?: string; email?: string }> };
  const users = Array.isArray(data.users) ? data.users : [];
  const user = users.find((u) => (u.email ?? "").toLowerCase() === DEMO_EMAIL);
  if (!user?.id) throw new Error("demo user exists but was not found in the admin list");
  const upd = await fetch(`${base}/admin/users/${user.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ password: DEMO_PASSWORD, email_confirm: true }),
  });
  if (!upd.ok) {
    throw new Error(`GoTrue update → ${upd.status} ${(await upd.text().catch(() => "")).slice(0, 160)}`.trim());
  }
}
