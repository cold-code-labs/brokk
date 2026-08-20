import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { actorFrom, canSeeProject } from "../actor.js";
import type { AppDeps } from "../app.js";
import { BancadaRefused } from "../bancada.js";
import type { Bancada } from "@brokk/core";

const OpenBody = z.object({
  projectId: z.string().uuid(),
  /** Working lane. `dev` is the shared one. */
  lane: z.string().max(40).optional(),
  branch: z.string().max(200).optional(),
  /** Rebuild with the current recipe even if the workspace is already up. */
  restart: z.boolean().optional(),
});

const MessageBody = z.object({ content: z.string().min(1).max(64_000) });
const CredentialBody = z.object({ token: z.string().min(20).max(200) });

/** A bancada is visible to whoever can see its project. Same rule as previews —
 *  the runtime does not get its own tenancy model. */
async function visible(deps: AppDeps, c: Context, bancada: Bancada | null): Promise<boolean> {
  if (!bancada) return false;
  const project = await deps.store.getProject(bancada.projectId);
  if (!project) return false;
  return canSeeProject(actorFrom(c), project.logtoOrgId);
}

function refused(c: Context, err: unknown) {
  if (err instanceof BancadaRefused) return c.json({ error: err.message }, err.status);
  throw err;
}

export function bancadasRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  /** The workspace brokering a git credential. Self-authenticating: the only
   *  proof is the per-bancada secret, which we hold as a hash. Mounted FIRST so
   *  the `:id` routes below can never shadow it.
   *
   *  ⚠️ This is the one route under /bancadas that the api-secret guard exempts,
   *  and it is exempted by EXACT path — never by prefix. A prefix exemption here
   *  would open every future /bancadas/* route by accident, which is exactly how
   *  the preview lane got a 401 incident (PR #118). */
  r.post("/git-credential", async (c) => {
    if (!deps.bancadas) return c.json({ error: "coder runtime not configured" }, 503);
    const parsed = CredentialBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    try {
      const cred = await deps.bancadas.gitCredential(parsed.data.token);
      return c.json(cred);
    } catch (err) {
      return refused(c, err);
    }
  });

  /** POST /bancadas — open (or adopt) the bancada of a project's lane. */
  r.post("/", async (c) => {
    if (!deps.bancadas) return c.json({ error: "coder runtime not configured" }, 503);
    const parsed = OpenBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const project = await deps.store.getProject(parsed.data.projectId);
    if (!project || !canSeeProject(actorFrom(c), project.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
    try {
      const bancada = await deps.bancadas.ensure(parsed.data.projectId, {
        lane: parsed.data.lane,
        branch: parsed.data.branch,
        restart: parsed.data.restart,
      });
      return c.json(bancada);
    } catch (err) {
      return refused(c, err);
    }
  });

  /** GET /bancadas?projectId= — cheap list, straight from the row. */
  r.get("/", async (c) => {
    const projectId = c.req.query("projectId") ?? undefined;
    if (projectId) {
      const project = await deps.store.getProject(projectId);
      if (!project || !canSeeProject(actorFrom(c), project.logtoOrgId)) {
        return c.json({ error: "not found" }, 404);
      }
      return c.json(await deps.store.listBancadas({ projectId }));
    }
    const actor = actorFrom(c);
    const rows = await deps.store.listBancadas({});
    const visibles = [];
    for (const b of rows) {
      const p = await deps.store.getProject(b.projectId);
      if (p && canSeeProject(actor, p.logtoOrgId)) visibles.push(b);
    }
    return c.json(visibles);
  });

  /** GET /bancadas/:id — re-reads Coder. This is the endpoint the screen polls,
   *  so it is also what reconciles a row that went stale. */
  r.get("/:id", async (c) => {
    const bancada = await deps.store.getBancada(c.req.param("id"));
    if (!(await visible(deps, c, bancada))) return c.json({ error: "not found" }, 404);
    if (!deps.bancadas) return c.json(bancada);
    return c.json(await deps.bancadas.refresh(bancada!));
  });

  r.post("/:id/stop", async (c) => {
    if (!deps.bancadas) return c.json({ error: "coder runtime not configured" }, 503);
    const bancada = await deps.store.getBancada(c.req.param("id"));
    if (!(await visible(deps, c, bancada))) return c.json({ error: "not found" }, 404);
    return c.json(await deps.bancadas.stop(bancada!));
  });

  r.delete("/:id", async (c) => {
    if (!deps.bancadas) return c.json({ error: "coder runtime not configured" }, 503);
    const bancada = await deps.store.getBancada(c.req.param("id"));
    if (!(await visible(deps, c, bancada))) return c.json({ error: "not found" }, 404);
    await deps.bancadas.remove(bancada!);
    return c.body(null, 204);
  });

  // ── the agent inside the bancada ────────────────────────────────────────────
  // Brokk proxies it: the workspace's agent face is never exposed to a browser,
  // and the conversation is read through the same tenancy check as the project.

  r.get("/:id/agent", async (c) => {
    if (!deps.bancadas) return c.json({ error: "coder runtime not configured" }, 503);
    const bancada = await deps.store.getBancada(c.req.param("id"));
    if (!(await visible(deps, c, bancada))) return c.json({ error: "not found" }, 404);
    try {
      const [status, messages] = await Promise.all([
        deps.bancadas.agentStatus(bancada!),
        deps.bancadas.agentMessages(bancada!),
      ]);
      return c.json({ status, messages });
    } catch (err) {
      return refused(c, err);
    }
  });

  r.post("/:id/agent", async (c) => {
    if (!deps.bancadas) return c.json({ error: "coder runtime not configured" }, 503);
    const bancada = await deps.store.getBancada(c.req.param("id"));
    if (!(await visible(deps, c, bancada))) return c.json({ error: "not found" }, 404);
    const parsed = MessageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    try {
      const ok = await deps.bancadas.agentSend(bancada!, parsed.data.content);
      return ok ? c.json({ ok: true }) : c.json({ error: "o agente não aceitou a mensagem" }, 502);
    } catch (err) {
      return refused(c, err);
    }
  });

  return r;
}
