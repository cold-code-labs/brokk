import {
  buildSystemPrompt,
  claudeCliAvailable,
  cursorCliAvailable,
  loadInstructionSkills,
  skillMetaList,
  type AflConfig,
  type AgentEvent,
  type Skill,
  type ToolContext,
  ANTHROPIC_DIRECT_URL,
  runTurn,
} from "@brokk/chat";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { runCliSessionTurn } from "./cli-turn.js";
import { unseal } from "./secrets.js";
import { autoTitle } from "./titler.js";
import { detectRuntime, runDiscovery, runMeetingScout, runResolve } from "@brokk/scout";
import { buildDetectCtx, resolveRuntime } from "@brokk/core/runtime";
import type { Store } from "@brokk/db";
import { featureBranch, type Repository } from "@brokk/core";
import { enhancePrompt, planJob, type MimirConfig, type MimirMode } from "@brokk/mimir";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { CheckoutManager } from "./checkout.js";
import { fsRoutes } from "./fs-routes.js";
import { devtreeRoutes } from "./devtree-routes.js";
import type { McpToolProvider } from "@brokk/mcp";
import { HeimdallAgentClient } from "./heimdall.js";
import { screencast } from "./live-view.js";
import { TurnManager } from "./turns.js";

/** Canonical engine ids + legacy aliases (afl/cli). */
export type ChatEngine = "claude-api" | "claude-cli" | "cursor-api" | "cursor-cli";

export function normalizeEngine(raw: string | null | undefined): ChatEngine {
  switch ((raw ?? "claude-api").toLowerCase()) {
    case "cli":
    case "claude-cli":
      return "claude-cli";
    case "cursor-cli":
      return "cursor-cli";
    case "cursor-api":
    case "cursor":
      return "cursor-api";
    case "afl":
    case "claude-api":
    case "brokk":
    default:
      return "claude-api";
  }
}

const ENGINE_ENUM = z.enum([
  "claude-api",
  "claude-cli",
  "cursor-api",
  "cursor-cli",
  // legacy
  "afl",
  "cli",
]);

export interface SindriDeps {
  store: Store;
  cfg: AflConfig;
  checkouts: CheckoutManager;
  turns: TurnManager;
  /** Shared secret the API proxy presents. Empty = open (dev). */
  runnerSecret: string;
  /** Connected MCP servers (ADR 0027 §4.1), or null when none configured. */
  mcp?: McpToolProvider | null;
}

const CreateSession = z.object({
  projectId: z.string().min(1),
  title: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  /** claude-api | claude-cli | cursor-api | cursor-cli (legacy: afl, cli). */
  engine: ENGINE_ENUM.optional(),
  /** Brokk Skill id from skills/<id>/SKILL.md (or a capability name). Empty = none. */
  skill: z.string().min(1).max(80).optional().nullable(),
  createdBy: z.string().optional(),
});

const PatchSession = z.object({
  title: z.string().optional(),
  status: z.enum(["active", "archived"]).optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high"]).nullable().optional(),
  /** Allowed only while the session still has zero messages (BROKK-33). */
  engine: ENGINE_ENUM.optional(),
});

const SendMessage = z.object({
  text: z.string().min(1),
  /** Optional Brokk Skill for this turn (slash `/skill` from the composer). */
  skill: z.string().min(1).max(80).optional().nullable(),
});

// Per-teammate seat routing for the interactive chat (default ON; BROKK_DIRECT_SEAT=0
// forces every turn back through the shared Ratatoskr seat). Mirrors the forge.
const SEAT_DIRECT = process.env.BROKK_DIRECT_SEAT !== "0";

// Live-preview edit mode (ADR 0017 dev-lane, opt-in via BROKK_LIVE_PREVIEW=1).
// When on, a chat turn edits DIRECTLY in the app's running preview worktree (on
// `dev`) — the same dir the preview's HMR dev server watches — so edits show live
// with no push (push becomes an explicit "Publish"). Off by default → each session
// keeps its own isolated `sindri/<id>` checkout (unchanged behaviour). The preview
// worktrees live under the runner workdir, on the volume both containers share.
const LIVE_PREVIEW = process.env.BROKK_LIVE_PREVIEW === "1";
const RUNNER_WORKDIR = process.env.BROKK_RUNNER_WORKDIR ?? "/home/brokk/work";

// In live mode multiple sessions share ONE dev worktree, and turn concurrency is
// per-session — so two sessions could edit the same files at once. Serialize turns
// by worktree path: a second turn on a live worktree already in use is rejected
// (like the per-session "already running" guard), rather than racing on disk.
const liveWorktreeLocks = new Set<string>();

/** The live preview worktree for a project (on `dev`), or null → fall back to the
 *  session's own checkout. Requires a booted preview (its HMR server is what makes
 *  the edit show live) whose worktree exists on disk. Never throws. */
async function livePreviewCheckout(
  deps: SindriDeps,
  projectId: string,
): Promise<{ path: string; branch: string } | null> {
  if (!LIVE_PREVIEW) return null;
  try {
    const previews = await deps.store.listPreviews({ projectId });
    const p = previews.find((x) => x.status === "live") ?? previews.find((x) => x.hauldrProject);
    if (!p) return null;
    const path = join(RUNNER_WORKDIR, "preview-worktrees", p.hauldrProject);
    return existsSync(path) ? { path, branch: p.branch } : null;
  } catch (e) {
    console.warn(`[sindri] live-preview resolve failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** The trusted caller identity, injected by the web proxy from the Logto session
 *  (empty for internal/server-side callers, which then see everything). */
function actorOf(c: Context): string {
  return (c.req.header("x-brokk-actor") ?? "").trim().toLowerCase();
}

/** Chat privacy: a human sees only their own sessions. Legacy sessions with no
 *  owner (created_by null) stay visible to everyone until backfilled. Internal
 *  callers (no actor header) see all. */
function canSee(session: { createdBy?: string | null }, actor: string): boolean {
  if (!actor) return true;
  if (!session.createdBy) return true;
  return session.createdBy.trim().toLowerCase() === actor;
}

/** The session owner's own active Max seat token (unsealed), or null → the turn
 *  falls back to the shared seat. Keys off the session's owner email. Never throws:
 *  a lookup/unseal hiccup returns null so chat never breaks. Toggle: BROKK_DIRECT_SEAT=0.
 *  Powers BOTH lanes — the afl gateway ("oauth" direct path) and the CLI subprocess
 *  (CLAUDE_CODE_OAUTH_TOKEN in its env). */
async function seatTokenFor(deps: SindriDeps, owner: string | null | undefined): Promise<string | null> {
  if (!SEAT_DIRECT || !owner) return null;
  try {
    const seat = await deps.store.activeSeatForEmail(owner);
    return seat ? unseal(seat.sealedToken) : null;
  } catch (e) {
    console.warn(`[sindri] seat resolve failed for ${owner}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** The afl gateway config for a turn: the owner's seat on the direct "oauth" path
 *  when present, else the shared Ratatoskr config unchanged. */
function seatCfg(deps: SindriDeps, token: string | null): AflConfig {
  if (!token) return deps.cfg;
  return { ...deps.cfg, authKind: "oauth", authToken: token, gatewayUrl: ANTHROPIC_DIRECT_URL };
}

export function buildSindri(deps: SindriDeps): Hono {
  const app = new Hono();
  app.use("*", cors());

  app.onError((err, c) => c.json({ error: err instanceof Error ? err.message : String(err) }, 500));
  app.get("/health", (c) => c.json({ ok: true, service: "sindri" }));

  // Which motors this Sindri image can actually run (BROKK-34: Cursor CLI needs
  // the glibc `agent` binary — Alpine chat historically advertises the chip but
  // create/patch then 400s, leaving the UI out of sync with the session).
  app.get("/engines", (c) => {
    const cursorCli = cursorCliAvailable();
    const claudeCli = claudeCliAvailable();
    const cursorSeat = Boolean(
      process.env.CURSOR_SEAT_URL || process.env.CURSOR_SEAT_INGRESS,
    );
    return c.json({
      engines: [
        { id: "claude-api", available: true },
        {
          id: "claude-cli",
          available: claudeCli,
          ...(claudeCli
            ? {}
            : { reason: "claude binary or CLAUDE_CODE_OAUTH_TOKEN missing" }),
        },
        {
          id: "cursor-api",
          available: cursorSeat,
          ...(cursorSeat ? {} : { reason: "CURSOR_SEAT_URL unset" }),
        },
        {
          id: "cursor-cli",
          available: cursorCli,
          ...(cursorCli
            ? {}
            : {
                reason:
                  "agent binary or CURSOR_API_KEY missing on this chat image — use Cursor API",
              }),
        },
      ],
    });
  });

  // Serve images produced by the generate_image tool. Reached in the browser via
  // the authed /api/chat/images/:id proxy hop. Ids are uuids we minted.
  app.get("/images/:id", async (c) => {
    const id = c.req.param("id").replace(/[^a-fA-F0-9-]/g, "");
    if (!id) return c.json({ error: "bad id" }, 400);
    try {
      const buf = await readFile(join(IMAGE_DIR, `${id}.png`));
      return new Response(new Uint8Array(buf), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
      });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  // Live-view (ADR 0054): an MJPEG screencast of the shared browser the QA agent
  // drives. The preview pane renders it with a plain <img src="…/live/:id"> — no
  // WebSocket client, no canvas. `:id` is the chat session (cosmetic for now; one
  // shared browser). 503 when nothing's driving yet.
  app.get("/live/:id", (c) => {
    const boundary = "brokkframe";
    const enc = new TextEncoder();
    let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          stop = await screencast((jpeg) => {
            try {
              controller.enqueue(
                enc.encode(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
              );
              controller.enqueue(new Uint8Array(jpeg));
              controller.enqueue(enc.encode("\r\n"));
            } catch {
              /* stream closed by the client */
            }
          });
        } catch {
          controller.close();
          return;
        }
        c.req.raw.signal.addEventListener("abort", () => {
          stop();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
      cancel() {
        stop();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Connection: "keep-alive",
      },
    });
  });

  // Shared-secret guard (the control-plane API injects it). Health + engine
  // catalogue stay open (no secrets — just which motors this image can run).
  app.use("*", async (c, next) => {
    if (!deps.runnerSecret) return next();
    if (c.req.path === "/health" || c.req.path === "/engines") return next();
    if (c.req.header("authorization") === `Bearer ${deps.runnerSecret}`) return next();
    return c.json({ error: "unauthorized" }, 401);
  });

  // Ownership guard: a human (actor set) can only touch a session they own. Legacy
  // ownerless sessions and internal callers (no actor) pass through. Applied to
  // every /sessions/:id route so isolation holds on read, patch, delete, and turns.
  const ownership = async (c: Context, next: () => Promise<void>) => {
    const id = c.req.param("id");
    const actor = actorOf(c);
    if (!id || !actor) return next();
    const s = await deps.store.getChatSession(id);
    if (s && !canSee(s, actor)) return c.json({ error: "not found" }, 404);
    return next();
  };
  app.use("/sessions/:id", ownership);
  app.use("/sessions/:id/*", ownership);

  // ── File viewer (the right-pane "code" tab) ──────────────────────────────────
  // Reads/writes the session's working checkout on disk. Mounted before the
  // session routes below; guarded by the same shared-secret middleware above.
  app.route("/", fsRoutes(deps.checkouts));
  app.route("/", devtreeRoutes({ store: deps.store, checkouts: deps.checkouts }));

  // ── Sessions ────────────────────────────────────────────────────────────────

  app.get("/skills", (c) => {
    const catalog = skillMetaList([
      {
        name: "discovery",
        description:
          "Scout THIS repository end-to-end (read-only) and return a structured brief.",
        kind: "capability",
      },
      {
        name: "enhance",
        description: "Rewrite a rough prompt/spec into a sharper one via Mímir.",
        kind: "capability",
      },
    ]);
    return c.json({ skills: catalog });
  });

  app.get("/sessions", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const status = (c.req.query("status") as "active" | "archived") || undefined;
    const actor = actorOf(c);
    const all = await deps.store.listChatSessions({ projectId, status });
    // Privacy: a human sees only their own (+ legacy ownerless) sessions.
    const sessions = all.filter((s) => canSee(s, actor));
    // ?stats=1 decorates each session with its aggregate counters (one grouped
    // query), so the rail can show volume + token spend at a glance.
    if (c.req.query("stats")) {
      const stats = await deps.store.chatSessionStats(sessions.map((s) => s.id));
      const decorated = sessions.map((s) => ({
        ...s,
        stats: stats.get(s.id) ?? { messages: 0, tokensIn: 0, tokensOut: 0, lastMessageAt: null },
      }));
      return c.json({ sessions: decorated });
    }
    return c.json({ sessions });
  });

  app.post("/sessions", async (c) => {
    const parsed = CreateSession.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const project = await deps.store.getProject(parsed.data.projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    const engine = normalizeEngine(parsed.data.engine);
    if (engine === "claude-cli" && !claudeCliAvailable()) {
      return c.json(
        { error: "Claude CLI unavailable: claude binary or CLAUDE_CODE_OAUTH_TOKEN missing" },
        400,
      );
    }
    if (engine === "cursor-cli" && !cursorCliAvailable()) {
      return c.json(
        { error: "Cursor CLI unavailable: agent binary or CURSOR_API_KEY/CURSOR_AUTH_TOKEN missing" },
        400,
      );
    }
    // "auto" is Cursor-seat only — never persist it on a Claude engine (BROKK-34).
    let model = parsed.data.model ?? "haiku";
    if (model === "auto" && engine !== "cursor-api" && engine !== "cursor-cli") {
      model = "sonnet";
    }
    const skillRaw = parsed.data.skill?.trim() || null;
    if (skillRaw) {
      const known = new Set(skillMetaList([
        { name: "discovery", description: "", kind: "capability" },
        { name: "enhance", description: "", kind: "capability" },
      ]).map((s) => s.name));
      if (!known.has(skillRaw)) {
        return c.json({ error: `unknown skill "${skillRaw}"` }, 400);
      }
    }

    const created = await deps.store.insertChatSession({
      projectId: project.id,
      title: parsed.data.title ?? "New chat",
      model,
      effort: parsed.data.effort ?? null,
      engine,
      skill: skillRaw,
      // Owner = the trusted Logto identity from the proxy; body value is only a
      // fallback for internal callers. This is what chat privacy + seat routing key off.
      createdBy: actorOf(c) || parsed.data.createdBy || null,
    });
    // Branch is derived from the (db-assigned) id so it's stable + collision-free.
    const branch = `sindri/${created.id.slice(0, 8)}`;
    const session = await deps.store.updateChatSession(created.id, { branch });
    return c.json({ session }, 201);
  });

  app.get("/sessions/:id", async (c) => {
    const session = await deps.store.getChatSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    const messages = await deps.store.listChatMessages(session.id);
    return c.json({ session, messages, running: deps.turns.isRunning(session.id) });
  });

  app.patch("/sessions/:id", async (c) => {
    const parsed = PatchSession.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const id = c.req.param("id");
    const existing = await deps.store.getChatSession(id);
    if (!existing) return c.json({ error: "not found" }, 404);

    if (parsed.data.engine !== undefined) {
      const engine = normalizeEngine(parsed.data.engine);
      const msgs = await deps.store.listChatMessages(id);
      if (msgs.length > 0 && normalizeEngine(existing.engine) !== engine) {
        return c.json(
          {
            error:
              "engine is locked after the first message — open a new chat to switch motors",
          },
          409,
        );
      }
      if (engine === "claude-cli" && !claudeCliAvailable()) {
        return c.json(
          { error: "Claude CLI unavailable: claude binary or CLAUDE_CODE_OAUTH_TOKEN missing" },
          400,
        );
      }
      if (engine === "cursor-cli" && !cursorCliAvailable()) {
        return c.json(
          { error: "Cursor CLI unavailable: agent binary or CURSOR_API_KEY/CURSOR_AUTH_TOKEN missing" },
          400,
        );
      }
      const { engine: _rawEng, ...rest } = parsed.data;
      let model = rest.model;
      if (
        (model === "auto" || (model === undefined && existing.model === "auto")) &&
        engine !== "cursor-api" &&
        engine !== "cursor-cli"
      ) {
        model = "sonnet";
      }
      const session = await deps.store.updateChatSession(id, {
        ...rest,
        ...(model !== undefined ? { model } : {}),
        engine,
      });
      return c.json({ session });
    }

    // Model-only patch: never leave "auto" on a Claude engine.
    const patch = { ...parsed.data };
    const eng = normalizeEngine(existing.engine);
    if (
      patch.model === "auto" &&
      eng !== "cursor-api" &&
      eng !== "cursor-cli"
    ) {
      patch.model = "sonnet";
    }
    const session = await deps.store.updateChatSession(id, patch);
    return c.json({ session });
  });

  app.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const session = await deps.store.getChatSession(id);
    if (session) {
      deps.turns.stop(id);
      const project = await deps.store.getProject(session.projectId);
      const repo = project ? await deps.store.getRepository(project.repositoryId) : null;
      if (repo) await deps.checkouts.remove({ sessionId: id, repo }).catch(() => {});
      await deps.store.deleteChatSession(id);
    }
    return c.json({ ok: true });
  });

  // Transcript (incremental via ?afterSeq=).
  app.get("/sessions/:id/messages", async (c) => {
    const afterSeq = c.req.query("afterSeq") ? Number(c.req.query("afterSeq")) : -1;
    const messages = await deps.store.listChatMessages(c.req.param("id"), afterSeq);
    return c.json({ messages });
  });

  // ── Turns ───────────────────────────────────────────────────────────────────

  // Post a message: start a detached turn, then stream its events. If the client
  // disconnects, the turn keeps running (overnight) — reattach via /stream.
  app.post("/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const parsed = SendMessage.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const session = await deps.store.getChatSession(id);
    if (!session) return c.json({ error: "not found" }, 404);
    if (deps.turns.isRunning(id)) return c.json({ error: "a turn is already running" }, 409);

    try {
      deps.turns.start(id, (emit, signal) =>
        runSessionTurn(deps, id, parsed.data.text, emit, signal, {
          skill: parsed.data.skill?.trim() || null,
        }),
      );
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
    return streamSession(deps, id, c);
  });

  // Attach to an in-flight (or just-finished) turn.
  app.get("/sessions/:id/stream", (c) => streamSession(deps, c.req.param("id"), c));

  app.post("/sessions/:id/stop", (c) => {
    const stopped = deps.turns.stop(c.req.param("id"));
    return c.json({ stopped });
  });

  // ── Huginn: project discovery ─────────────────────────────────────────────────

  // In-flight scouts, so a re-trigger (or the connect fire + a manual re-scout)
  // doesn't run two at once for the same project.
  const scouting = new Set<string>();

  // Kick a (detached) discovery scout for a project. Returns immediately; the
  // brief row tracks pending → ready/failed. Idempotent while in flight.
  app.post("/discover/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await deps.store.getProject(projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    if (scouting.has(projectId)) return c.json({ status: "pending", running: true }, 202);
    const repo = await deps.store.getRepository(project.repositoryId);
    if (!repo) return c.json({ error: "repository not found" }, 404);

    scouting.add(projectId);
    await deps.store.upsertProjectBrief(projectId, { status: "pending" });

    // Detached: survives the HTTP response (like a turn). Scout reads a fresh
    // read-only checkout off the project's base branch, then stores the brief.
    void (async () => {
      const branch = `huginn/${projectId.slice(0, 8)}`;
      try {
        const { path } = await deps.checkouts.ensure({
          sessionId: `huginn-${projectId}`,
          branch,
          repo: repo as Parameters<typeof deps.checkouts.ensure>[0]["repo"],
          baseBranch: project.baseBranch,
        });
        const brief = await runDiscovery({
          cfg: deps.cfg,
          cwd: path,
          repoFullName: repo.fullName,
          model: "haiku",
          onProgress: (n) => console.log(`[huginn] ${repo.fullName}: ${n}`),
        });
        await deps.store.upsertProjectBrief(projectId, {
          status: "ready",
          mission: brief.mission,
          summary: brief.summary,
          built: brief.built,
          missing: brief.missing,
          stack: brief.stack,
          model: "haiku",
          error: null,
        });
        console.log(`[huginn] ${repo.fullName}: brief ready (${brief.missing.length} gaps)`);

        // Sleipnir: pin how to run this repo, decided once here (this scout IS the
        // rescan, so re-detect from scratch — pass null). The preview supervisor
        // then boots from the pinned spec without re-inferring. Best-effort: a
        // detection hiccup must never fail the discovery.
        try {
          const ctx = buildDetectCtx(path);
          const spec = await resolveRuntime(null, ctx, (c) =>
            detectRuntime(c, {
              cfg: deps.cfg,
              model: "haiku",
              onProgress: (n) => console.log(`[huginn-runtime] ${repo.fullName}: ${n}`),
            }),
          );
          await deps.store.setProjectRuntime(projectId, spec);
          console.log(
            `[huginn-runtime] ${repo.fullName}: ${spec.label} (supported=${spec.supported}, source=${spec.source})`,
          );
        } catch (err) {
          console.warn(
            `[huginn-runtime] ${repo.fullName}: runtime pin skipped — ${err instanceof Error ? err.message : err}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[huginn] ${repo.fullName}: scout failed — ${msg}`);
        await deps.store.upsertProjectBrief(projectId, { status: "failed", error: msg }).catch(() => {});
      } finally {
        scouting.delete(projectId);
      }
    })();

    return c.json({ status: "pending", running: true }, 202);
  });

  // Fetch a project's brief (+ whether a scout is currently running).
  app.get("/discover/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const brief = await deps.store.getProjectBrief(projectId);
    return c.json({ brief, running: scouting.has(projectId) });
  });

  // ── Resolve: per-card analysis ────────────────────────────────────────────────

  // In-flight analyses, so re-triggering (or answering a question → re-run) doesn't
  // run two Resolve scouts at once for the same card.
  const analyzing = new Set<string>();

  // Kick a (detached) Resolve scout for ONE card. Moves the card into the `analysis`
  // column and returns immediately; the analysis row tracks pending → ready/failed.
  // Human input threads in: `answers` (to earlier questions) and `details` ("Adicionar
  // Detalhes" — NEW authoritative info). When there's human input AND a prior head,
  // a NEW version is started (the head is snapshotted into revisions); otherwise the
  // current version is recomputed in place.
  app.post("/analyze/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const task = await deps.store.getTask(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    if (analyzing.has(taskId)) return c.json({ status: "pending", running: true }, 202);
    const project = await deps.store.getProject(task.projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    const repo = await deps.store.getRepository(project.repositoryId);
    if (!repo) return c.json({ error: "repository not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const answers = typeof body?.answers === "string" && body.answers.trim() ? body.answers.trim() : undefined;
    const details = typeof body?.details === "string" && body.details.trim() ? body.details.trim() : undefined;

    // Read the prior head to (a) know if this refine should bump a version and
    // (b) hand Resolve the previous version to improve on.
    const head = await deps.store.getTaskAnalysis(taskId);
    const humanInput = [details && `Detalhes: ${details}`, answers && `Respostas: ${answers}`]
      .filter(Boolean)
      .join("\n");
    const prior =
      head && head.status !== "failed"
        ? { version: head.version, title: head.revisedTitle ?? task.title, details: head.details, approach: head.approach }
        : undefined;

    analyzing.add(taskId);
    // New version only when the human contributed input AND there's a head to revise;
    // otherwise just mark the current head pending (fresh compute / bare re-run).
    if (humanInput && head && head.status === "ready") {
      await deps.store.beginAnalysisRevision(taskId, humanInput);
    } else {
      await deps.store.setAnalysisStatus(taskId, "pending");
    }
    // Entering analysis IS the card's state — surface it on the board immediately.
    await deps.store.updateTask(taskId, { status: "analysis" }).catch(() => {});

    // Detached: survives the HTTP response (like discovery). Resolve reads a fresh
    // read-only checkout off the card's base branch, then stores the plan.
    void (async () => {
      const branch = `resolve/${taskId.slice(0, 8)}`;
      try {
        const { path } = await deps.checkouts.ensure({
          sessionId: `resolve-${taskId}`,
          branch,
          repo: repo as Parameters<typeof deps.checkouts.ensure>[0]["repo"],
          baseBranch: task.baseBranch ?? project.baseBranch,
        });
        const analysis = await runResolve({
          cfg: deps.cfg,
          cwd: path,
          repoFullName: repo.fullName,
          card: { title: task.title, body: task.body },
          evidence: task.evidence,
          answers,
          details,
          prior,
          model: "sonnet",
          onProgress: (n) => console.log(`[resolve] ${task.title}: ${n}`),
        });
        await deps.store.upsertTaskAnalysis(taskId, {
          status: "ready",
          revisedTitle: analysis.revisedTitle,
          details: analysis.details,
          evidence: analysis.evidence,
          approach: analysis.approach,
          rationale: analysis.rationale,
          mode: analysis.mode,
          steps: analysis.steps,
          questions: analysis.questions,
          model: "sonnet",
          error: null,
        });
        console.log(
          `[resolve] ${task.title}: analysis ready (${analysis.mode}, ${analysis.steps.length} steps, ${analysis.questions.length} questions, ${analysis.evidence.length} quotes)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[resolve] ${task.title}: analysis failed — ${msg}`);
        await deps.store.setAnalysisStatus(taskId, "failed", msg).catch(() => {});
      } finally {
        analyzing.delete(taskId);
      }
    })();

    return c.json({ status: "pending", running: true }, 202);
  });

  // Fetch a card's analysis (+ whether a scout is currently running).
  app.get("/analyze/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const analysis = await deps.store.getTaskAnalysis(taskId);
    return c.json({ analysis, running: analyzing.has(taskId) });
  });

  // ── Muninn backfill ──────────────────────────────────────────────────────────
  // Re-run Muninn on a transcript and attach its verbatim `evidencia` to the cards
  // it already produced — so pre-evidence cards gain real quotes for traceability.
  // Matching is by CONTENT token-overlap (title+body), not title equality: the new
  // Muninn corrects titles, so an exact-title match would miss the very cards we fixed.
  app.post("/muninn/backfill/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await deps.store.getProject(projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const transcript = typeof body?.transcript === "string" ? body.transcript : "";
    const meetingTitle = typeof body?.meetingTitle === "string" ? body.meetingTitle : "Reunião";
    if (!transcript.trim()) return c.json({ error: "transcript required" }, 400);

    const scout = await runMeetingScout({
      cfg: deps.cfg,
      transcript,
      meetingTitle,
      model: "sonnet",
      onProgress: (n) => console.log(`[muninn-backfill] ${project.name}: ${n}`),
    });

    const cards = await deps.store.listTasks({ projectId });
    const tok = (s: string): Set<string> =>
      new Set(
        (s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]{4,}/g) ?? []).filter(
          (w) => !STOPWORDS.has(w),
        ),
      );
    const overlap = (a: Set<string>, b: Set<string>): number => {
      let n = 0;
      for (const t of a) if (b.has(t)) n++;
      return n;
    };
    const cardTokens = cards.map((t) => ({ card: t, tokens: tok(`${t.title} ${t.body}`) }));

    const results: { ajuste: string; matched: string | null; quotes: number }[] = [];
    let updated = 0;
    for (const a of scout.ajustes) {
      if (!a.evidencia.length) continue;
      const at = tok(`${a.titulo} ${a.o_que_pediram}`);
      let best: { card: (typeof cards)[number]; score: number } | null = null;
      for (const ct of cardTokens) {
        const s = overlap(at, ct.tokens);
        if (!best || s > best.score) best = { card: ct.card, score: s };
      }
      if (!best || best.score < 3) {
        results.push({ ajuste: a.titulo, matched: null, quotes: a.evidencia.length });
        continue;
      }
      await deps.store.updateTask(best.card.id, {
        evidence: a.evidencia.map((e) => ({ quote: e.quote, speaker: e.speaker ?? null, note: null })),
      });
      updated++;
      results.push({ ajuste: a.titulo, matched: best.card.title, quotes: a.evidencia.length });
    }
    console.log(`[muninn-backfill] ${project.name}: ${updated}/${scout.ajustes.length} cards updated`);
    return c.json({ ajustes: scout.ajustes.length, updated, results });
  });

  return app;
}

// Common Portuguese words to ignore when matching ajustes to cards by content.
const STOPWORDS = new Set([
  "para", "pelo", "pela", "como", "está", "esta", "esse", "essa", "isso", "aqui",
  "vaso", "então", "cada", "mais", "muito", "todo", "toda", "quando", "onde", "porque",
  "sobre", "entre", "também", "ainda", "pode", "vamos", "fazer", "feito", "sendo",
  "reunião", "muninn", "card", "cliente", "vira", "plano",
]);

/** Run one turn for a session: ensure the checkout, build context, drive the loop,
 *  and keep the session's turn_state honest no matter how it ends. */
async function runSessionTurn(
  deps: SindriDeps,
  sessionId: string,
  text: string,
  emit: (e: AgentEvent) => void,
  signal: AbortSignal,
  opts?: { skill?: string | null },
): Promise<void> {
  let session = await deps.store.getChatSession(sessionId);
  if (!session) throw new Error("session not found");
  // Slash-picked skill: persist on the session so later turns keep the pin,
  // and so CLI/API lanes both see session.skill.
  if (opts?.skill) {
    const known = new Set(
      skillMetaList([
        { name: "discovery", description: "", kind: "capability" },
        { name: "enhance", description: "", kind: "capability" },
      ]).map((s) => s.name),
    );
    if (known.has(opts.skill) && session.skill !== opts.skill) {
      session =
        (await deps.store.updateChatSession(session.id, { skill: opts.skill })) ?? {
          ...session,
          skill: opts.skill,
        };
    }
  }
  const project = await deps.store.getProject(session.projectId);
  if (!project) throw new Error("project not found");
  const repo = await deps.store.getRepository(project.repositoryId);
  if (!repo) throw new Error("repository not found");

  // First exchange? (no messages yet) → auto-name the thread after the turn.
  const isFirstTurn = (await deps.store.listChatMessages(session.id)).length === 0;

  // Live mode: edit the running preview's `dev` worktree directly (HMR shows it
  // live, no push). Else the session's own isolated checkout, as before.
  const live = await livePreviewCheckout(deps, project.id);
  let branch: string;
  let path: string;
  if (live) {
    branch = live.branch;
    path = live.path;
    emit({ type: "status", phase: "checkout", detail: { branch, live: true } });
  } else {
    branch = session.branch ?? `sindri/${session.id.slice(0, 8)}`;
    // Live mode is on but no preview is running for this app → we can't edit the
    // live worktree, so we fall back to this session's isolated branch. Tell the
    // user, otherwise their edit silently lands off-preview and looks like a no-op.
    if (LIVE_PREVIEW) {
      emit({
        type: "status",
        phase: "live_unavailable",
        detail: { branch, reason: "sem preview rodando — editando o branch isolado da sessão (inicie o preview p/ editar ao vivo)" },
      });
    }
    emit({ type: "status", phase: "checkout", detail: { branch } });
    path = (
      await deps.checkouts.ensure({
        sessionId: session.id,
        branch,
        repo: repo as Repository,
        baseBranch: project.baseBranch,
      })
    ).path;
  }

  // Serialize concurrent live-worktree edits across sessions (see liveWorktreeLocks).
  if (live && liveWorktreeLocks.has(path)) {
    emit({
      type: "error",
      message: "Outra sessão está editando este preview ao vivo agora — tente de novo em instantes.",
    });
    return;
  }
  if (live) liveWorktreeLocks.add(path);

  await deps.store.updateChatSession(session.id, { turnState: "running", lastTurnAt: new Date() }).catch(() => {});

  // Bill this turn to the session owner's own Max seat when they have one; else
  // the shared seat, unchanged. One lookup feeds both Claude lanes: the CLI
  // subprocess (CLAUDE_CODE_OAUTH_TOKEN) and the API gateway (direct "oauth" path).
  const seatToken = await seatTokenFor(deps, session.createdBy);
  const engine = normalizeEngine(session.engine);

  // CLI lanes (Claude Code / Cursor Agent) — genuine headless clients, no Afl loop.
  if (engine === "claude-cli" || engine === "cursor-cli") {
    try {
      await runCliSessionTurn({
        session: { ...session, branch },
        userText: text,
        cfg: deps.cfg,
        seatToken: seatToken ?? undefined,
        store: deps.store,
        cwd: path,
        repoFullName: repo.fullName,
        emit,
        signal,
        kind: engine === "cursor-cli" ? "cursor" : "claude",
      });
    } finally {
      if (live) liveWorktreeLocks.delete(path);
      await deps.store.updateChatSession(session.id, { turnState: "idle" }).catch(() => {});
    }
    if (isFirstTurn) {
      void autoTitle(deps.store, deps.cfg, session.id, text, (title) => emit({ type: "title", title }));
    }
    return;
  }

  const skills = buildSkills(deps, project.id, repo.fullName, path, emit);
  const pinnedSkill = session.skill
    ? skills.find((s) => s.name === session.skill)
    : undefined;
  const toolCtx: ToolContext = {
    cwd: path,
    projectId: project.id,
    sessionId: session.id,
    store: deps.store,
    baseBranch: project.baseBranch,
    extraExec: deps.mcp?.executor,
    skills,
    onDomainEvent: (e) => emit({ type: "status", phase: e.kind, detail: e.detail }),
    // The plan_work tool bridges to Mímir — Haiku decides to plan, the strong
    // planner decomposes, the cards land in the backlog (proposed) for approval.
    // Surface a status: the strong planner call takes a while (chat shows it).
    planWork: (intent) => {
      emit({ type: "status", phase: "planejando" });
      return runPlan(deps, project, intent);
    },
    // The generate_image tool bridges to the Cursor seat's image lane (Ratatoskr
    // cursor-img). Generation is slow (~1–2 min) — surface a status; the PNG is
    // persisted and returned as a markdown tag served via the /api/chat/* proxy.
    generateImage: (prompt) => {
      emit({ type: "status", phase: "gerando imagem" });
      return runImage(prompt);
    },
    // Infra-intent bridges (set_env / redeploy_app / register_route /
    // register_job) → Heimdall's scoped Agent API. Present only when the agent
    // token is configured; the tools are confirmation-gated in makeDomainExecutor.
    infra: heimdallInfra(emit),
  };
  const system = await buildSystemPrompt({
    cwd: path,
    store: deps.store,
    projectId: project.id,
    projectName: project.name,
    repoFullName: repo.fullName,
    branch,
    skills,
    pinnedSkill,
  });

  // Cursor API → Ratatoskr cursor sidecar (Messages-compat). Claude API → seat
  // (oauth direct or LiteLLM/Ratatoskr Anthropic) as before.
  const turnCfg =
    engine === "cursor-api"
      ? cursorApiCfg(deps)
      : seatCfg(deps, seatToken);

  try {
    await runTurn({
      session: {
        ...session,
        branch,
        // Cursor seat likes concrete "auto"/composer ids; map Brokk aliases.
        model:
          engine === "cursor-api"
            ? process.env.BROKK_CURSOR_MODEL ||
              (session.model === "opus" ? "composer-2.5" : "auto")
            : session.model,
      },
      userText: text,
      cfg: turnCfg,
      toolCtx,
      system,
      extraTools: deps.mcp?.toolDefs,
      emit,
      signal,
    });
  } finally {
    if (live) liveWorktreeLocks.delete(path);
    await deps.store.updateChatSession(session.id, { turnState: "idle" }).catch(() => {});
  }
  if (isFirstTurn) {
    void autoTitle(deps.store, deps.cfg, session.id, text, (title) => emit({ type: "title", title }));
  }
}

// ── generate_image bridge ────────────────────────────────────────────────────
// Hits the Cursor seat's image lane (OpenAI /v1/images/generations), persists the
// PNG under IMAGE_DIR (on the durable /home/brokk volume, so it survives redeploys),
// and returns a markdown tag pointing at GET /images/:id — reachable in the browser
// through the authed /api/chat/* proxy (which strips /chat → /images/:id).
//
// Routing is env-driven:
//   • default → the cursor-img sidecar directly, with the same ingress key the
//     cursor-api engine already uses (self-contained, no LiteLLM dependency).
//   • metered → set CURSOR_IMAGE_URL=http://litellm:4000 + CURSOR_IMAGE_KEY=<vkey>;
//     the request carries model=CURSOR_IMAGE_MODEL so LiteLLM attributes/ budgets it.
// The model field is harmless to the sidecar (its shim ignores it).
const IMAGE_BASE = (process.env.CURSOR_IMAGE_URL || "http://ratatoskr-cursor-img:8794").replace(/\/$/, "");
const IMAGE_KEY =
  process.env.CURSOR_IMAGE_KEY ||
  process.env.CURSOR_SEAT_INGRESS ||
  process.env.CURSOR_INGRESS_KEYS?.split(",")[0]?.trim() ||
  "";
const IMAGE_MODEL = process.env.CURSOR_IMAGE_MODEL || "cursor-image";
// Persist under the runner workdir (on the durable /home/brokk volume, writable by
// the app uid) so images survive redeploys. Fall back to tmp elsewhere (ephemeral
// but always writable) — NOT homedir(): the app runs with HOME unset (→ "/"), which
// is not writable (EACCES).
const IMAGE_DIR =
  process.env.BROKK_CHAT_IMAGES_DIR ||
  (process.env.BROKK_RUNNER_WORKDIR
    ? join(process.env.BROKK_RUNNER_WORKDIR, ".chat-images")
    : join(tmpdir(), "brokk-chat-images"));

async function runImage(prompt: string): Promise<{ ok: boolean; content: string }> {
  if (!IMAGE_KEY)
    return { ok: false, content: "image generation is not configured (CURSOR_IMAGE_KEY/CURSOR_SEAT_INGRESS unset)" };
  try {
    const res = await fetch(`${IMAGE_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${IMAGE_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, n: 1 }),
      signal: AbortSignal.timeout(240_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, content: `image generation failed (${res.status}): ${t.slice(0, 200)}` };
    }
    const j = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) return { ok: false, content: "image generation returned no image" };
    const id = randomUUID();
    await mkdir(IMAGE_DIR, { recursive: true });
    await writeFile(join(IMAGE_DIR, `${id}.png`), Buffer.from(b64, "base64"));
    return { ok: true, content: `![${prompt.slice(0, 80)}](/api/chat/images/${id})` };
  } catch (e) {
    return { ok: false, content: `image generation error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Cursor API = Messages (or OpenAI via LiteLLM) against the Ratatoskr cursor
 *  sidecar. Prefer CURSOR_SEAT_URL (direct :8791) or fall through LiteLLM. */
function cursorApiCfg(deps: SindriDeps): AflConfig {
  const base =
    process.env.CURSOR_SEAT_URL ||
    process.env.CURSOR_BRIDGE_URL ||
    "http://127.0.0.1:8791";
  const token =
    process.env.CURSOR_SEAT_INGRESS ||
    process.env.CURSOR_INGRESS_KEYS?.split(",")[0]?.trim() ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    deps.cfg.authToken;
  return {
    ...deps.cfg,
    authKind: "bearer",
    authToken: token,
    gatewayUrl: base.replace(/\/$/, ""),
  };
}

/** Mímir config for Sindri's plan_work — openai-mode against the CCL gateway
 *  (LiteLLM → Ratatoskr), the same proven path the /plan page uses in prod. We
 *  force this transport because Sindri's image has no `claude` CLI (the planner's
 *  default). Planning runs on the STRONG model; SINDRI_PLAN_MODEL can override
 *  (e.g. to haiku) when the shared seat is tight. */
function plannerConfig(): MimirConfig | null {
  const apiKey = process.env.MIMIR_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
  if (!apiKey) return null;
  const gw = (process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
  const baseUrl = process.env.MIMIR_BASE_URL || `${gw}/v1`;
  const model = process.env.SINDRI_PLAN_MODEL || process.env.MIMIR_PLANNER_MODEL || "claude-sonnet-4-6";
  return {
    provider: "openai",
    enhanceModel: model,
    triageModel: model,
    plannerModel: model,
    baseUrl,
    apiKey,
    authToken: "",
    anthropicBaseUrl: "",
  };
}

/** Brokk Skills for a chat turn (ADR 0039). Capability skills are bound here;
 *  instruction skills load from skills/<id>/SKILL.md (BROKK_SKILLS_DIR). */
function buildSkills(
  deps: SindriDeps,
  projectId: string,
  repoFullName: string,
  cwd: string,
  emit: (e: AgentEvent) => void,
): Skill[] {
  const capabilities: Skill[] = [
    {
      name: "discovery",
      description:
        "Scout THIS repository end-to-end (read-only) and return a structured brief — mission, what's built, what's missing, and the stack. Use for a fresh map of an unfamiliar or freshly-connected project. Takes no input.",
      run: async () => {
        emit({ type: "status", phase: "discovery" });
        const brief = await runDiscovery({ cfg: deps.cfg, cwd, repoFullName, model: "haiku" });
        await deps.store
          .upsertProjectBrief(projectId, {
            status: "ready",
            mission: brief.mission,
            summary: brief.summary,
            built: brief.built,
            missing: brief.missing,
            stack: brief.stack,
            model: "haiku",
            error: null,
          })
          .catch(() => {});
        const out = [
          `**Mission:** ${brief.mission}`,
          "",
          brief.summary,
          "",
          "**Built:**",
          ...brief.built.map((b) => `- ${b}`),
          "",
          "**Missing:**",
          ...brief.missing.map((m) => `- ${m}`),
          "",
          `**Stack:** ${brief.stack.join(", ")}`,
        ].join("\n");
        return { ok: true, content: out };
      },
    },
    {
      name: "enhance",
      description:
        "Rewrite a rough prompt/spec into a sharper one via Mímir. Pass { input: <prompt to refine>, mode?: 'polish' | 'structure' | 'engineer' }. Use when the user hands you a vague or messy request and wants it tightened before acting.",
      run: async (input) => {
        const text = String(input.input ?? input.prompt ?? "").trim();
        if (!text) return { ok: false, content: "enhance needs an 'input' prompt to refine" };
        const cfg = plannerConfig();
        if (!cfg) return { ok: false, content: "enhance unavailable (no gateway credentials)" };
        const modeRaw = String(input.mode ?? "structure");
        const mode: MimirMode = (["polish", "structure", "engineer"].includes(modeRaw)
          ? modeRaw
          : "structure") as MimirMode;
        emit({ type: "status", phase: "enhance" });
        const res = await enhancePrompt(text, mode, cfg);
        return {
          ok: true,
          content: `Enhanced (${res.mode}):\n\n${res.enhanced}\n\n— rationale: ${res.rationale}`,
        };
      },
    },
  ];
  const fromDisk = loadInstructionSkills();
  const claimed = new Set(capabilities.map((s) => s.name));
  return [...capabilities, ...fromDisk.filter((s) => !claimed.has(s.name))];
}

/** Build Sindri's infra-intent bridge over Heimdall's SCOPED Agent API. Returns
 *  undefined when HEIMDALL_AGENT_URL/_TOKEN are unset, which disables the infra
 *  tools for the session (they report "not available"). Reads process.env
 *  directly, the same idiom as plannerConfig above. Emits a status per call so
 *  the chat surfaces the mutation as it runs. */
function heimdallInfra(emit: (e: AgentEvent) => void): ToolContext["infra"] {
  const baseUrl = (process.env.HEIMDALL_AGENT_URL || "").replace(/\/$/, "");
  const token = process.env.HEIMDALL_AGENT_TOKEN || "";
  if (!baseUrl || !token) return undefined;
  const client = new HeimdallAgentClient(baseUrl, token);
  const status = (phase: string) => emit({ type: "status", phase });
  return {
    listEnv: (app) => {
      status("infra: list_env");
      return client.listEnv(app);
    },
    rotateEnv: (app, key, opts) => {
      status("infra: rotate_env");
      return client.rotateEnv(app, key, opts);
    },
    setEnv: (app, key, value, opts) => {
      status("infra: set_env");
      return client.setEnv(app, key, value, opts);
    },
    redeploy: (app) => {
      status("infra: redeploy");
      return client.redeploy(app);
    },
    registerRoute: (input) => {
      status("infra: register_route");
      return client.registerRoute(input);
    },
    registerJob: (input) => {
      status("infra: register_job");
      return client.registerJob(input);
    },
  };
}

/** The plan_work bridge: decompose an intent via the Mímir planner and drop the
 *  result into the project as PROPOSED work. Backlog is the approval gate —
 *  nothing runs until a human queues it from the Quadro (then the forge builds it).
 *
 *  A FEATURE (a 2+ card DAG) becomes a proper Plan: one row + cards linked by
 *  planId/planKey/dependsOn, so the forge composes them into ONE shared-branch PR
 *  (this ports the retired Planejador's apply path into the chat). The plan rests
 *  at status "planning" until its first card pushes a PR (which flips it to
 *  "forging"). An ATOMIC result stays a single loose backlog card. */
async function runPlan(
  deps: SindriDeps,
  project: { id: string; baseBranch: string },
  intent: string,
): Promise<{ ok: boolean; content: string }> {
  const cfg = plannerConfig();
  if (!cfg) return { ok: false, content: "planner unavailable (no gateway credentials)" };
  let draft;
  try {
    draft = await planJob(intent, cfg);
  } catch (e) {
    return { ok: false, content: `planner failed: ${(e as Error).message}` };
  }
  const forcas = draft.cards.map((c) => c.forca).join(", ");
  const questions =
    draft.questions.length > 0
      ? ` Dúvidas do planejador (relaie ao usuário antes que ele aprove): ${draft.questions
          .map((q) => q.question)
          .join(" | ")}`
      : "";
  const base = draft.targetBranch || project.baseBranch;

  // FEATURE → a real Plan/DAG: one shared feature branch, cards linked by planKey.
  if (draft.mode === "feature" && draft.cards.length > 1) {
    const created = await deps.store.insertPlan({
      projectId: project.id,
      prompt: intent,
      summary: draft.summary,
      rationale: draft.rationale || null,
      mode: "feature",
      status: "planning",
      featureBranch: "pending",
      baseBranch: base,
      model: draft.model ?? null,
      createdBy: "sindri-plan",
    });
    const plan = await deps.store.updatePlan(created.id, {
      featureBranch: featureBranch(draft.summary, created.id),
    });
    for (const card of draft.cards) {
      await deps.store.insertTask({
        projectId: project.id,
        title: card.title || intent.slice(0, 60),
        body: `${card.body}\n\n— planejado pelo Sindri (Mímir)`,
        status: "backlog",
        kind: "implement",
        planId: plan.id,
        planKey: card.key,
        dependsOn: card.dependsOn,
        baseBranch: base,
        createdBy: "sindri-plan",
        labels: ["plan"],
        acceptance: card.acceptance || null,
        forca: card.forca,
        touches: card.touches,
      });
    }
    return {
      ok: true,
      content: `Propus a feature "${draft.summary}" — ${draft.cards.length} cards encadeados (DAG) no backlog [forças: ${forcas}]. Revise no Quadro e aprove: a forja compõe todos em UM PR na branch \`${plan.featureBranch}\`.${questions}`,
    };
  }

  // ATOMIC → a single loose proposed card.
  for (const card of draft.cards) {
    await deps.store.insertTask({
      projectId: project.id,
      title: card.title || intent.slice(0, 60),
      body: `${card.body}\n\n— planejado pelo Sindri (Mímir)`,
      status: "backlog",
      baseBranch: base,
      createdBy: "sindri-plan",
      labels: ["plan"],
      acceptance: card.acceptance || null,
      forca: card.forca,
      touches: card.touches,
    });
  }
  return {
    ok: true,
    content: `Plano "${draft.summary}" (${draft.mode}): ${draft.cards.length} card(s) no backlog [forças: ${forcas}]. Aguardam aprovação no Quadro — não rodam até serem enfileirados.${questions}`,
  };
}

/** Stream a session's live events over SSE. Unsubscribes (but never aborts the
 *  turn) when the client disconnects. */
function streamSession(deps: SindriDeps, sessionId: string, c: Context) {
  return streamSSE(c, async (stream) => {
    const queue: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    const unsub = deps.turns.subscribe(sessionId, (e) => {
      queue.push(e);
      wake?.();
      wake = null;
    });
    stream.onAbort(() => unsub());
    try {
      while (!stream.closed) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 15_000).unref?.();
          });
        }
        if (queue.length === 0) {
          await stream.writeSSE({ event: "ping", data: "{}" });
          continue;
        }
        let terminal = false;
        while (queue.length) {
          const e = queue.shift()!;
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
          if (e.type === "done" || e.type === "error") terminal = true;
        }
        if (terminal) break;
      }
    } finally {
      unsub();
    }
  });
}
