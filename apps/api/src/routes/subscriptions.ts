import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { preview, seal } from "../secrets.js";
import { completeSetupToken, startSetupToken } from "../setup-token.js";

const CompleteBody = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(4),
  userId: z.string().uuid(),
  label: z.string().max(80).optional(),
});

const TokenBody = z.object({
  userId: z.string().uuid(),
  // The Max OAuth token the member generated locally with `claude setup-token`.
  token: z.string().regex(/^sk-ant-oat01-[A-Za-z0-9_-]+$/, "expected a sk-ant-oat01… token"),
  label: z.string().max(80).optional(),
});

const OrgFuelBody = z.object({
  logtoOrgId: z.string().min(1),
  // The org's OmniRoute fuel key (sk-…). Minted by Asgard; sealed here.
  apiKey: z.string().min(8),
  label: z.string().max(80).optional(),
});

export function subscriptionsRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => c.json(await deps.store.listSubscriptions()));

  // Step 1: start the Max OAuth — returns the authorize URL for the user.
  r.post("/connect/start", async (c) => {
    try {
      const { sessionId, url } = await startSetupToken();
      return c.json({ sessionId, url });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Step 2: user pasted the code → exchange it, seal the token, store the seat.
  r.post("/connect/complete", async (c) => {
    const parsed = CompleteBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { sessionId, code, userId, label } = parsed.data;

    const user = await deps.store.getUser(userId);
    if (!user) return c.json({ error: "user not found" }, 404);

    let token: string;
    try {
      token = await completeSetupToken(sessionId, code);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    const sub = await deps.store.insertSubscription({
      userId,
      kind: "max",
      label: label || `${user.name}'s Max`,
      sealedToken: seal(token),
      tokenPreview: preview(token),
      status: "active",
    });
    return c.json(sub, 201);
  });

  // Simplest path (no server-side CLI): the member ran `claude setup-token` on
  // their own machine and pastes the sk-ant-oat token; we seal & store it. This
  // sidesteps needing the `claude` binary + a PTY in the API container.
  r.post("/connect/token", async (c) => {
    const parsed = TokenBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { userId, token, label } = parsed.data;
    const user = await deps.store.getUser(userId);
    if (!user) return c.json({ error: "user not found" }, 404);
    const sub = await deps.store.insertSubscription({
      userId,
      kind: "max",
      label: label || `${user.name}'s Max`,
      sealedToken: seal(token),
      tokenPreview: preview(token),
      status: "active",
    });
    return c.json(sub, 201);
  });

  // Org fuel line (E6 · ASGARD-25): a Asgard (a central) empurra a fuel key da org
  // (uma OmniRoute key) — selada aqui, nunca guardada crua. Guardado por
  // BROKK_API_SECRET (middleware do app). Idempotente por org.
  r.put("/org-fuel", async (c) => {
    const parsed = OrgFuelBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { logtoOrgId, apiKey, label } = parsed.data;
    const res = await deps.store.upsertOrgFuelSeat({
      logtoOrgId,
      sealedToken: seal(apiKey),
      tokenPreview: preview(apiKey),
      label,
    });
    return c.json({ ok: true, subscriptionId: res.subscriptionId });
  });

  r.delete("/org-fuel/:orgId", async (c) => {
    await deps.store.removeOrgFuelSeat(c.req.param("orgId"));
    return c.json({ ok: true });
  });

  return r;
}
