/** Hide Hauldr sidecars from Brokk House — only real product projects.
 *
 *  Mirrors Heimdall's Coolify `SIDECAR_RE` and agent list filter. Product apps
 *  named `hauldr` / `hauldr-panel` / `hauldr-mcp` stay; per-tenant
 *  `hauldr-auth-<project>` etc. do not. */

const SIDECAR_RE = /^hauldr-(auth|rest|storage|realtime|db)-/i;

export function isSidecarProjectName(name: string | null | undefined): boolean {
  if (!name) return false;
  return SIDECAR_RE.test(name.trim());
}

export function isProductHeimdallApp(app: {
  name: string;
  slug: string;
  status: string;
  lifecycle: string;
  repoFullName?: string | null;
}): boolean {
  if (app.status === "destroyed") return false;
  if (app.lifecycle === "terminated") return false;
  if (isSidecarProjectName(app.name) || isSidecarProjectName(app.slug)) return false;
  if (!app.repoFullName?.trim()) return false;
  return true;
}
