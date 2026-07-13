import {
  buildSystemPrompt,
  claudeCliAvailable,
  type AflConfig,
  type AgentEvent,
  type Skill,
  type ToolContext,
  runTurn,
} from "@brokk/chat";
import { runCliSessionTurn } from "./cli-turn.js";
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
import type { McpToolProvider } from "@brokk/mcp";
import { HeimdallAgentClient } from "./heimdall.js";
import { TurnManager } from "./turns.js";

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
  /** afl (native loop, default) | cli (Claude Code CLI lane, opt-in). */
  engine: z.enum(["afl", "cli"]).optional(),
  createdBy: z.string().optional(),
});

const PatchSession = z.object({
  title: z.string().optional(),
  status: z.enum(["active", "archived"]).optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high"]).nullable().optional(),
});

const SendMessage = z.object({ text: z.string().min(1) });

export function buildSindri(deps: SindriDeps): Hono {
  const app = new Hono();
  app.use("*", cors());

  app.onError((err, c) => c.json({ error: err instanceof Error ? err.message : String(err) }, 500));
  app.get("/health", (c) => c.json({ ok: true, service: "sindri" }));

  // Shared-secret guard (the control-plane API injects it). Health stays open.
  app.use("*", async (c, next) => {
    if (!deps.runnerSecret) return next();
    if (c.req.path === "/health") return next();
    if (c.req.header("authorization") === `Bearer ${deps.runnerSecret}`) return next();
    return c.json({ error: "unauthorized" }, 401);
  });

  // ── File viewer (the right-pane "code" tab) ──────────────────────────────────
  // Reads/writes the session's working checkout on disk. Mounted before the
  // session routes below; guarded by the same shared-secret middleware above.
  app.route("/", fsRoutes(deps.checkouts));

  // ── Sessions ────────────────────────────────────────────────────────────────

  app.get("/sessions", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const status = (c.req.query("status") as "active" | "archived") || undefined;
    const sessions = await deps.store.listChatSessions({ projectId, status });
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
    if (parsed.data.engine === "cli" && !claudeCliAvailable()) {
      return c.json(
        { error: "CLI engine unavailable: claude binary or CLAUDE_CODE_OAUTH_TOKEN missing" },
        400,
      );
    }

    const created = await deps.store.insertChatSession({
      projectId: project.id,
      title: parsed.data.title ?? "New chat",
      model: parsed.data.model ?? "haiku",
      effort: parsed.data.effort ?? null,
      engine: parsed.data.engine ?? "afl",
      createdBy: parsed.data.createdBy ?? null,
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
    const session = await deps.store.updateChatSession(c.req.param("id"), parsed.data);
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
      deps.turns.start(id, (emit, signal) => runSessionTurn(deps, id, parsed.data.text, emit, signal));
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
): Promise<void> {
  const session = await deps.store.getChatSession(sessionId);
  if (!session) throw new Error("session not found");
  const project = await deps.store.getProject(session.projectId);
  if (!project) throw new Error("project not found");
  const repo = await deps.store.getRepository(project.repositoryId);
  if (!repo) throw new Error("repository not found");

  // First exchange? (no messages yet) → auto-name the thread after the turn.
  const isFirstTurn = (await deps.store.listChatMessages(session.id)).length === 0;

  const branch = session.branch ?? `sindri/${session.id.slice(0, 8)}`;
  emit({ type: "status", phase: "checkout", detail: { branch } });
  const { path } = await deps.checkouts.ensure({
    sessionId: session.id,
    branch,
    repo: repo as Repository,
    baseBranch: project.baseBranch,
  });

  await deps.store.updateChatSession(session.id, { turnState: "running", lastTurnAt: new Date() }).catch(() => {});

  // CLI engine lane (opt-in per session): the genuine Claude Code CLI runs the
  // turn in the same checkout — no Afl loop, no gateway/Ratatoskr hop. The afl
  // path below stays the default and is untouched.
  if (session.engine === "cli") {
    try {
      await runCliSessionTurn({
        session: { ...session, branch },
        userText: text,
        cfg: deps.cfg,
        store: deps.store,
        cwd: path,
        repoFullName: repo.fullName,
        emit,
        signal,
      });
    } finally {
      await deps.store.updateChatSession(session.id, { turnState: "idle" }).catch(() => {});
    }
    if (isFirstTurn) {
      void autoTitle(deps.store, deps.cfg, session.id, text, (title) => emit({ type: "title", title }));
    }
    return;
  }

  const skills = buildSkills(deps, project.id, repo.fullName, path, emit);
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
  });

  try {
    await runTurn({
      session: { ...session, branch },
      userText: text,
      cfg: deps.cfg,
      toolCtx,
      system,
      extraTools: deps.mcp?.toolDefs,
      emit,
      signal,
    });
  } finally {
    await deps.store.updateChatSession(session.id, { turnState: "idle" }).catch(() => {});
  }
  if (isFirstTurn) {
    void autoTitle(deps.store, deps.cfg, session.id, text, (title) => emit({ type: "title", title }));
  }
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

/** The Brokk Skills available in a chat turn (ADR 0039). The former codename
 *  features become skills reached via `invoke_skill`:
 *   • discovery (Huginn) — scout the current checkout, return a structured brief.
 *   • enhance (Mímir)    — rewrite a rough prompt into a sharper one.
 *  Bound per-turn to the session's checkout + project, mirroring the plan_work
 *  bridge. More skills (review, migrate, …) slot in here. */
function buildSkills(
  deps: SindriDeps,
  projectId: string,
  repoFullName: string,
  cwd: string,
  emit: (e: AgentEvent) => void,
): Skill[] {
  return [
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
