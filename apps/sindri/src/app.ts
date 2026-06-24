import {
  buildSystemPrompt,
  type ChatConfig,
  type SindriEvent,
  type ToolContext,
  runTurn,
} from "@brokk/chat";
import type { Store } from "@brokk/db";
import type { Repository } from "@brokk/core";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { CheckoutManager } from "./checkout.js";
import { TurnManager } from "./turns.js";

export interface SindriDeps {
  store: Store;
  cfg: ChatConfig;
  checkouts: CheckoutManager;
  turns: TurnManager;
  /** Shared secret the API proxy presents. Empty = open (dev). */
  runnerSecret: string;
}

const CreateSession = z.object({
  projectId: z.string().min(1),
  title: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
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

  // ── Sessions ────────────────────────────────────────────────────────────────

  app.get("/sessions", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const status = (c.req.query("status") as "active" | "archived") || undefined;
    const sessions = await deps.store.listChatSessions({ projectId, status });
    return c.json({ sessions });
  });

  app.post("/sessions", async (c) => {
    const parsed = CreateSession.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const project = await deps.store.getProject(parsed.data.projectId);
    if (!project) return c.json({ error: "project not found" }, 404);

    const created = await deps.store.insertChatSession({
      projectId: project.id,
      title: parsed.data.title ?? "New chat",
      model: parsed.data.model ?? "sonnet",
      effort: parsed.data.effort ?? null,
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

  return app;
}

/** Run one turn for a session: ensure the checkout, build context, drive the loop,
 *  and keep the session's turn_state honest no matter how it ends. */
async function runSessionTurn(
  deps: SindriDeps,
  sessionId: string,
  text: string,
  emit: (e: SindriEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const session = await deps.store.getChatSession(sessionId);
  if (!session) throw new Error("session not found");
  const project = await deps.store.getProject(session.projectId);
  if (!project) throw new Error("project not found");
  const repo = await deps.store.getRepository(project.repositoryId);
  if (!repo) throw new Error("repository not found");

  const branch = session.branch ?? `sindri/${session.id.slice(0, 8)}`;
  emit({ type: "status", phase: "checkout", detail: { branch } });
  const { path } = await deps.checkouts.ensure({
    sessionId: session.id,
    branch,
    repo: repo as Repository,
    baseBranch: project.baseBranch,
  });

  await deps.store.updateChatSession(session.id, { turnState: "running", lastTurnAt: new Date() }).catch(() => {});

  const toolCtx: ToolContext = {
    cwd: path,
    projectId: project.id,
    store: deps.store,
    baseBranch: project.baseBranch,
    onDomainEvent: (e) => emit({ type: "status", phase: e.kind, detail: e.detail }),
  };
  const system = await buildSystemPrompt({
    cwd: path,
    store: deps.store,
    projectId: project.id,
    projectName: project.name,
    repoFullName: repo.fullName,
    branch,
  });

  try {
    await runTurn({ session: { ...session, branch }, userText: text, cfg: deps.cfg, toolCtx, system, emit, signal });
  } finally {
    await deps.store.updateChatSession(session.id, { turnState: "idle" }).catch(() => {});
  }
}

/** Stream a session's live events over SSE. Unsubscribes (but never aborts the
 *  turn) when the client disconnects. */
function streamSession(deps: SindriDeps, sessionId: string, c: Context) {
  return streamSSE(c, async (stream) => {
    const queue: SindriEvent[] = [];
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
