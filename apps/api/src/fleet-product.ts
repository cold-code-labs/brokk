/** Hide Hauldr / infra from Brokk House — only product projects.

 *  Sidecars (`hauldr-auth-*` …) AND the Hauldr product itself (`hauldr`,
 *  `hauldr-panel`, `hauldr-mcp`) stay out of the House floor. Brokk forges
 *  client/internal apps, not the data plane. */

const SIDECAR_RE = /^hauldr-(auth|rest|storage|realtime|db)-/i;
const INFRA_EXACT = new Set(["hauldr", "hauldr-panel", "hauldr-mcp", "hauldr-engine"]);

function key(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function isSidecarProjectName(name: string | null | undefined): boolean {
  if (!name) return false;
  const k = key(name);
  if (INFRA_EXACT.has(k)) return true;
  return SIDECAR_RE.test(k) || SIDECAR_RE.test(name.trim());
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
