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
 * Reaper: every poll tick the supervisor kills processes whose expiresAt has
 * passed.  A manual DELETE /previews/:id marks the row 'stopped'; the next
 * tick kills the local process immediately.
 *
 * TTL: set by BROKK_PREVIEW_TTL_MS (default 45 min) — stored in expiresAt on
 * each start.  The supervisor never depends on the db's hardcoded 24 h touch.
 */
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Preview, Repository } from "@brokk/core";
import type { RunnerConfig } from "./config.js";
import type { GhProvider } from "./git.js";
import type { HauldrClient } from "./hauldr.js";

interface LivePreview {
  proc: ChildProcess;
  port: number;
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
          if (this.live.has(p.id) || this.booting.has(p.id)) break;
          this.booting.add(p.id);
          void this.boot(p)
            .catch((err) => {
              console.error(`[preview-supervisor] boot ${p.id} error:`, err);
              void this.controlPatch(`/previews/${p.id}`, { status: "failed" }).catch(
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
            await this.reapBackend(p);
            break;
          }

          // TTL expired
          if (p.expiresAt && new Date(p.expiresAt) < new Date()) {
            console.log(`[preview-supervisor] ${p.subdomain} TTL expired, stopping`);
            this.killAndClean(p.id, lp);
            await this.controlPatch(`/previews/${p.id}`, {
              status: "stopped",
              pid: null,
              port: null,
            }).catch(() => {});
            await this.reapBackend(p);
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
            await this.reapBackend(p);
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
    }>(`/projects/${preview.projectId}`);
    const repo = await this.controlGet<Repository>(
      `/repositories/${project.repositoryId}`,
    );

    // Provision (or fetch) the Hauldr dev-DB for this preview
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

    // Resolve the working directory.
    //   • dev mode (a Sindri session): run straight in the session's live
    //     checkout — the SAME worktree the chat agent edits. We must NOT
    //     git-refresh/reset it (that would clobber the agent's uncommitted work);
    //     Sindri owns its lifecycle. `next dev` then hot-reloads on every edit.
    //   • build mode (Fleet preview): refresh (or create) the persistent worktree,
    //     reused by hauldrProject slug so node_modules survive restarts.
    const isDev = preview.mode === "dev";
    let wtPath: string;
    if (isDev) {
      if (!preview.workDir) {
        throw new Error(`dev preview ${preview.subdomain}: workDir is unset`);
      }
      wtPath = preview.workDir;
      if (!existsSync(join(wtPath, "package.json"))) {
        throw new Error(
          `dev preview ${preview.subdomain}: no package.json at ${wtPath} (session checkout missing)`,
        );
      }
    } else {
      ({ path: wtPath } = await this.git.persistentCheckout({
        repo,
        branch: preview.branch,
        name: preview.hauldrProject,
      }));
    }

    // Schema-as-code parity with prod: if the checkout ships db/migrations + the
    // migrate client, apply them to this preview's Hauldr project BEFORE boot —
    // mirroring what the prod Docker entrypoint does on deploy. Idempotent
    // (tracked in _hauldr_migrations) so only new files run. Dev logs-and-continues
    // where prod aborts: a broken migration surfaces in the preview, not silently.
    const migrateScript = join(wtPath, "scripts/hauldr-migrate.mjs");
    if (migrateToken && this.cfg.hauldrControlUrl && existsSync(migrateScript)) {
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
    const cmd = this.expandCmd(isDev ? this.cfg.previewDevCmd : this.cfg.previewCmd, port);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...hauldrEnv,
      PORT: String(port),
      // Dev previews need development mode for HMR; build previews default to
      // production so apps skip dev-only overhead.
      NODE_ENV: isDev ? "development" : (process.env.NODE_ENV ?? "production"),
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
    this.live.set(preview.id, { proc, port });

    // Update the control plane: live + pid + port + expiresAt (runner-defined TTL)
    const expiresAt = new Date(Date.now() + this.cfg.previewTtlMs).toISOString();
    await this.controlPatch(`/previews/${preview.id}`, {
      status: "live",
      pid: proc.pid ?? null,
      port,
      expiresAt,
    });

    console.log(
      `[preview-supervisor] ${preview.subdomain} live on :${port}` +
        ` (pid=${proc.pid}, expires=${expiresAt})`,
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
          void this.reapBackend(preview).catch(() => {});
        }
      }
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

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

  /** Tear down a stopped preview's Hauldr compute (auth + rest), keeping the
   *  database, so an idle backend costs ~MB of DB and zero containers. No-op
   *  when ephemeral mode is off, Hauldr is unconfigured, or the project is
   *  pinned (a standing env that happens to share the slug). Called on TTL
   *  expiry / manual stop / unexpected exit — NEVER on graceful shutdown, where
   *  previews are meant to resume after the runner restarts. */
  private async reapBackend(preview: Preview): Promise<void> {
    if (!this.cfg.previewEphemeral || !this.hauldr) return;
    const project = preview.hauldrProject;
    if (!project) return;
    if (this.cfg.previewPinned.has(project)) {
      console.log(
        `[preview-supervisor] ${preview.subdomain}: ${project} pinned — keeping compute`,
      );
      return;
    }
    try {
      await this.hauldr.deprovisionCompute(project);
      console.log(
        `[preview-supervisor] ${preview.subdomain}: deprovisioned compute for ${project} (DB kept)`,
      );
    } catch (err) {
      console.warn(
        `[preview-supervisor] ${preview.subdomain}: deprovision failed for ${project}:`,
        err,
      );
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
