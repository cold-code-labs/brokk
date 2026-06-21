/**
 * Logto owns identity; Brokk owns authority. Logto carries the role names in the
 * token (`roles` claim); this maps them to a rank so the UI can gate by the
 * highest role a user holds.
 */
export const ROLES = ["Membro", "Admin", "Proprietário"] as const;
export type Role = (typeof ROLES)[number];

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
