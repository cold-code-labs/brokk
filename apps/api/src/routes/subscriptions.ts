import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { orgTenancyEnabled, requireActor } from "../actor.js";
import { preview, seal } from "../secrets.js";
import { completeSetupToken, startSetupToken } from "../setup-token.js";

const CompleteBody = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(4),
  /** Optional target user — staff only. Non-staff always bind to their own row. */
  userId: z.string().uuid().optional(),
  label: z.string().max(80).optional(),
});

const TokenBody = z.object({
  userId: z.string().uuid().optional(),
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

async function userIdForActorEmail(
  store: AppDeps["store"],
  email: string,
): Promise<{ id: string; name: string } | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const users = await store.listUsers();
  const user = users.find((u) => u.email.trim().toLowerCase() === e);
  return user ? { id: user.id, name: user.name } : null;
}

export function subscriptionsRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => {
    const who = requireActor(c, deps.runnerSecret);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    const actor = who.actor;
    if (!orgTenancyEnabled() || actor.isStaff) {
      return c.json(await deps.store.listSubscriptions());
    }
    // Non-staff: own Max seats + fuel lines for their orgs — never the fleet.
    const all = await deps.store.listSubscriptions();
    const me = await userIdForActorEmail(deps.store, actor.email);
    return c.json(
      all.filter((s) => {
        if (s.kind === "fuel") {
          return Boolean(s.logtoOrgId && actor.orgIds.includes(s.logtoOrgId));
        }
        return me != null && s.userId === me.id;
      }),
    );
  });

  // Step 1: start the Max OAuth — returns the authorize URL for the user.
  r.post("/connect/start", async (c) => {
    const who = requireActor(c, deps.runnerSecret);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    if (!who.actor.email && !who.actor.isStaff) return c.json({ error: "actor required" }, 401);
    try {
      const { sessionId, url } = await startSetupToken();
      return c.json({ sessionId, url });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Step 2: user pasted the code → exchange it, seal the token, store the seat.
  r.post("/connect/complete", async (c) => {
    const who = requireActor(c, deps.runnerSecret);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    const parsed = CompleteBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { sessionId, code, label, userId: requestedUserId } = parsed.data;

    let user: { id: string; name: string } | null = null;
    if (who.actor.isStaff && requestedUserId) {
      const u = await deps.store.getUser(requestedUserId);
      user = u ? { id: u.id, name: u.name } : null;
    } else {
      if (!who.actor.email) return c.json({ error: "actor required" }, 401);
      user = await userIdForActorEmail(deps.store, who.actor.email);
    }
    if (!user) return c.json({ error: "user not found" }, 404);

    let token: string;
    try {
      token = await completeSetupToken(sessionId, code);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    const sub = await deps.store.insertSubscription({
      userId: user.id,
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
  // Non-staff always bind to their own user row; staff may target userId.
  r.post("/connect/token", async (c) => {
    const who = requireActor(c, deps.runnerSecret);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    const parsed = TokenBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { token, label, userId: requestedUserId } = parsed.data;

    let user: { id: string; name: string } | null = null;
    if (who.actor.isStaff && requestedUserId) {
      const u = await deps.store.getUser(requestedUserId);
      user = u ? { id: u.id, name: u.name } : null;
    } else {
      if (!who.actor.email) return c.json({ error: "actor required" }, 401);
      user = await userIdForActorEmail(deps.store, who.actor.email);
    }
    if (!user) return c.json({ error: "user not found" }, 404);

    const sub = await deps.store.insertSubscription({
      userId: user.id,
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
    const who = requireActor(c, deps.runnerSecret);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    if (!who.actor.isStaff) return c.json({ error: "forbidden" }, 403);
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
    const who = requireActor(c, deps.runnerSecret);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    if (!who.actor.isStaff) return c.json({ error: "forbidden" }, 403);
    await deps.store.removeOrgFuelSeat(c.req.param("orgId"));
    return c.json({ ok: true });
  });

  return r;
}
