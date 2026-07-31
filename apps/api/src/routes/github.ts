import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { requestActor } from "../actor.js";
import type { AppDeps } from "../app.js";
import {
  getAppMeta,
  getInstallation,
  githubAppReady,
  loadAppAuth,
} from "../github.js";

/**
 * Per-org GitHub connection (ADR 0064). An org admin starts an install of the
 * Eitri App on THEIR GitHub org/user; GitHub redirects to /github/setup with the
 * new installation id + our signed `state` (which carries the logto org). We bind
 * installation→org so repo discovery + git ops use that org's own installation.
 *
 * The state is an HMAC over "<orgId>.<ts>" — the setup callback is unauthenticated
 * (a browser redirect from github.com), so the signature is what proves the org.
 */
const STATE_TTL_MS = 15 * 60_000;

function signState(secret: string, orgId: string, ts: number): string {
  const body = `${orgId}.${ts}`;
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return Buffer.from(`${body}.${sig}`).toString("base64url");
}

function verifyState(secret: string, state: string): string | null {
  let decoded: string;
  try {
    decoded = Buffer.from(state, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const i = decoded.lastIndexOf(".");
  if (i < 0) return null;
  const body = decoded.slice(0, i);
  const sig = decoded.slice(i + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const dot = body.indexOf(".");
  if (dot < 0) return null;
  const orgId = body.slice(0, dot);
  const ts = Number(body.slice(dot + 1));
  if (!orgId || !Number.isFinite(ts) || Date.now() - ts > STATE_TTL_MS) return null;
  return orgId;
}

// The app slug rarely changes; cache it so /connect/start doesn't hit GitHub each time.
let slugCache: { slug: string; exp: number } | null = null;
async function appSlug(auth: NonNullable<ReturnType<typeof loadAppAuth>>): Promise<string> {
  if (slugCache && slugCache.exp > Date.now()) return slugCache.slug;
  const meta = await getAppMeta(auth);
  slugCache = { slug: meta.slug, exp: Date.now() + 60 * 60_000 };
  return meta.slug;
}

/** Resolve the org this actor is acting for (staff may pass ?orgId=). */
function actorOrgId(orgQuery: string | undefined, isStaff: boolean, orgIds: string[]): string | null {
  if (isStaff && orgQuery) return orgQuery;
  return orgIds[0] ?? (isStaff ? (orgQuery ?? null) : null);
}

export function githubRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  const secret = deps.githubWebhookSecret || deps.apiSecret || "brokk-dev-state";
  const webBase = (process.env.BROKK_WEB_URL || "").replace(/\/$/, "");

  // Is this org's GitHub connected? Lists its installations (account + status).
  r.get("/status", async (c) => {
    const actor = requestActor(c, deps.runnerSecret);
    const orgId = actorOrgId(c.req.query("orgId"), actor.isStaff, actor.orgIds);
    if (!orgId) return c.json({ ready: githubAppReady(), connected: false, installations: [] });
    const insts = await deps.store.listInstallationsForOrgs([orgId]);
    return c.json({
      ready: githubAppReady(),
      connected: insts.length > 0,
      installations: insts.map((i) => ({
        installationId: i.installationId,
        accountLogin: i.accountLogin,
        accountType: i.accountType,
        suspended: Boolean(i.suspendedAt),
      })),
    });
  });

  // Start the install: returns the github.com URL the admin opens to install the
  // Eitri App on their own GitHub org/user, carrying a signed state = this org.
  r.post("/connect/start", async (c) => {
    const auth = loadAppAuth();
    if (!auth) return c.json({ error: "GitHub App não configurado" }, 503);
    const actor = requestActor(c, deps.runnerSecret);
    const orgId = actorOrgId(c.req.query("orgId"), actor.isStaff, actor.orgIds);
    if (!orgId) return c.json({ error: "sem organização na sessão" }, 403);
    let slug: string;
    try {
      slug = await appSlug(auth);
    } catch (e) {
      return c.json({ error: `não consegui resolver o app: ${e instanceof Error ? e.message : e}` }, 502);
    }
    const state = signState(secret, orgId, Date.now());
    const url = `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
    return c.json({ url });
  });

  // GitHub redirects the browser here after install (Setup URL). Unauthenticated —
  // the signed `state` proves the org. Binds installation→org, then bounces to the
  // web connect page.
  r.get("/setup", async (c) => {
    const auth = loadAppAuth();
    const installationId = c.req.query("installation_id");
    const state = c.req.query("state") ?? "";
    const back = (ok: string) => c.redirect(`${webBase || ""}/connect?github=${ok}`);
    if (!auth || !installationId) return back("error");
    const orgId = verifyState(secret, state);
    if (!orgId) return back("badstate");
    try {
      const info = await getInstallation(auth, installationId);
      await deps.store.upsertInstallation({
        installationId,
        logtoOrgId: orgId,
        accountLogin: info.accountLogin,
        accountType: info.accountType,
        suspendedAt: info.suspended ? new Date() : null,
      });
    } catch {
      return back("error");
    }
    return back("connected");
  });

  // Disconnect: drop the mapping (the actual GitHub uninstall is done on github.com).
  r.delete("/installations/:id", async (c) => {
    const actor = requestActor(c, deps.runnerSecret);
    const id = c.req.param("id");
    const inst = await deps.store.getInstallation(id);
    if (!inst) return c.json({ ok: true });
    const orgId = actorOrgId(c.req.query("orgId"), actor.isStaff, actor.orgIds);
    if (!actor.isStaff && inst.logtoOrgId !== orgId) {
      return c.json({ error: "forbidden" }, 403);
    }
    await deps.store.deleteInstallation(id);
    return c.json({ ok: true });
  });

  return r;
}
