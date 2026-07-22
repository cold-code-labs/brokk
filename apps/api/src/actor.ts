import type { Context } from "hono";

/**
 * Trusted actor from the web BFF (Logto session → headers). Never trust
 * client-supplied org claims — the proxy overwrites them (ADR 0064).
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
  const email = (c.req.header("x-brokk-actor") ?? "").trim().toLowerCase();
  const orgIds = (c.req.header("x-brokk-org-ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isStaff = c.req.header("x-brokk-is-staff") === "1";
  return { email, orgIds, isStaff };
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
