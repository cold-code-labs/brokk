/**
 * Logto owns identity; Brokk owns authority. Logto carries the role names in the
 * token (`roles` claim); this maps them to a rank so the UI can gate by the
 * highest role a user holds.
 *
 * ADR 0064 / BROKK-47: org-scoped tenancy. Staff = org Cold Code Labs **or**
 * global Logto role Admin/Proprietário. Org-role `admin` of a *client* org is
 * NOT staff — never conflate the two.
 */
export const ROLES = ["Membro", "Admin", "Proprietário"] as const;
export type Role = (typeof ROLES)[number];

/** Logto organization id for CCL staff (ADR 0045 / 0064). */
export const CCL_ORG_ID = process.env.BROKK_CCL_ORG_ID ?? "d5qacs8kwh79";

/** When set, client-org members may enter Brokk (API must filter by org). Until
 *  then, layout fail-closes anyone who is not CCL staff (ADR 0064 T0). */
export const orgTenancyEnabled = process.env.BROKK_ORG_TENANCY === "1";

export type OrgRole = { orgId: string; role: string };

const RANK: Record<string, number> = { Membro: 1, Admin: 2, Proprietário: 3 };

export function rank(role: string | undefined): number {
  return role ? (RANK[role] ?? 0) : 0;
}

export function highestRole(roles: string[]): string | undefined {
  return [...roles].sort((a, b) => rank(b) - rank(a))[0];
}

export function atLeast(roles: string[], min: Role): boolean {
  return highestRole(roles) !== undefined && rank(highestRole(roles)) >= rank(min);
}

/** Parse Logto claim `organization_roles` (`"<orgId>:<roleName>"`). */
export function parseOrganizationRoles(raw: string[] | undefined): OrgRole[] {
  return (raw ?? []).map((s) => {
    const i = s.indexOf(":");
    return i < 0 ? { orgId: s, role: "" } : { orgId: s.slice(0, i), role: s.slice(i + 1) };
  });
}

export function isCclStaff(opts: {
  organizations: string[];
  roles: string[];
}): boolean {
  if (opts.organizations.includes(CCL_ORG_ID)) return true;
  return atLeast(opts.roles, "Admin");
}
