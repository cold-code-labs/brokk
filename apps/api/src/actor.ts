import type { Context } from "hono";
import { secretEquals } from "./secrets.js";

declare module "hono" {
  interface ContextVariableMap {
    /** Set by app.ts: true only when Authorization matches api/runner secret
     *  (or both secrets are empty in local/dev). */
    brokkTrustedHop: boolean;
  }
}

/**
 * Trusted actor from the web BFF (Logto session → headers). Never trust
 * client-supplied org claims — the proxy overwrites them (ADR 0064).
 *
 * TRUST BOUNDARY: `x-brokk-actor` / `x-brokk-org-ids` / `x-brokk-is-staff` are
 * only trustworthy after the hop authenticated with BROKK_API_SECRET or
 * BROKK_RUNNER_SECRET (`brokkTrustedHop`). Untrusted hops get an empty actor.
 */
export type Actor = {
  email: string;
  orgIds: string[];
  isStaff: boolean;
};

/** BROKK_ORG_TENANCY=1 enables API filtering for non-staff. Off = staff view for
 *  all callers (legado). Layout still fail-closes clients until this is on. */
export const orgTenancyEnabled = (): boolean => process.env.BROKK_ORG_TENANCY === "1";

export function actorFrom(c: Context): Actor {
  // Unset (unit tests that skip the middleware) → trust headers as before.
  if (c.get("brokkTrustedHop") === false) {
    return { email: "", orgIds: [], isStaff: false };
  }
  const email = (c.req.header("x-brokk-actor") ?? "").trim().toLowerCase();
  const orgIds = (c.req.header("x-brokk-org-ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isStaff = c.req.header("x-brokk-is-staff") === "1";
  return { email, orgIds, isStaff };
}

/**
 * Forge supervisor authenticates with BROKK_RUNNER_SECRET (same idea as the
 * /previews runner bypass). Elevate to staff so GET /projects|/repositories
 * resolves legado rows (`logto_org_id` null) — otherwise preview boot 404s.
 */
export function requestActor(c: Context, runnerSecret: string): Actor {
  const actor = actorFrom(c);
  if (!runnerSecret) return actor;
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secretEquals(token, runnerSecret)) {
    return { ...actor, isStaff: true };
  }
  return actor;
}

/**
 * When org tenancy is on, refuse an empty actor that would otherwise look
 * unrestricted (no email, no staff). Runner bearer elevates to isStaff and is
 * allowed without an email.
 */
export function requireActor(
  c: Context,
  runnerSecret: string,
): { ok: true; actor: Actor } | { ok: false; error: string; status: 401 } {
  const actor = requestActor(c, runnerSecret);
  if (orgTenancyEnabled() && !actor.isStaff && !actor.email) {
    return { ok: false, error: "actor required", status: 401 };
  }
  return { ok: true, actor };
}

/** Effective visibility for list/get. When tenancy is off, everyone sees the
 *  fleet (CCL dogfood). When on, non-staff are scoped to their org ids. */
export function listScope(actor: Actor): { orgIds?: string[]; isStaff: boolean } {
  if (!orgTenancyEnabled() || actor.isStaff) return { isStaff: true };
  return { isStaff: false, orgIds: actor.orgIds };
}

export function canSeeProject(actor: Actor, logtoOrgId: string | null | undefined): boolean {
  if (!orgTenancyEnabled() || actor.isStaff) return true;
  if (!logtoOrgId) return false;
  return actor.orgIds.includes(logtoOrgId);
}

/** Stamp org on create: non-staff must use their org; staff may leave null (CCL). */
export function resolveLogtoOrgId(
  actor: Actor,
  requested: string | null | undefined,
): { ok: true; logtoOrgId: string | null } | { ok: false; error: string; status: 403 } {
  if (!orgTenancyEnabled() || actor.isStaff) {
    return { ok: true, logtoOrgId: requested ?? null };
  }
  if (!actor.orgIds.length) return { ok: false, error: "no organization on session", status: 403 };
  return { ok: true, logtoOrgId: actor.orgIds[0]! };
}
