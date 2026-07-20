/**
 * Origin handling for a preview's dev-internal paths.
 *
 * Extracted from index.ts so it can be unit-tested: index.ts starts the server at
 * module scope, so importing it from a test would boot a listener.
 */

/** Next.js dev (15+/Turbopack) refuses requests to its dev resources — notably the
 *  `/_next/webpack-hmr` WebSocket — when the Origin is neither same-origin nor in
 *  the app's `allowedDevOrigins`. A preview is served from a proxy host the dev
 *  server never knows, so the socket is rejected and the client runtime stalls:
 *  the page renders its SSR output and never hydrates (no error, no interactivity).
 *  SCOPED to dev-internal prefixes so page routes keep their real Origin — Server
 *  Action CSRF validation depends on it (actions POST to page routes, never here).
 *
 *  Metro (Expo, divisão mobile) tem a mesma classe: `/hot`, `/message`, `*.bundle`,
 *  `/status`, `/symbolicate`, `/assets`, `/logs`, `/inspector`. */
export function isDevAssetPath(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("/_next/") || url.startsWith("/__nextjs")) return true;
  const path = url.split("?")[0];
  return (
    path === "/status" ||
    path === "/hot" ||
    path === "/message" ||
    path === "/symbolicate" ||
    path === "/logs" ||
    path.endsWith(".bundle") ||
    path.endsWith(".map") ||
    path.startsWith("/assets") ||
    path.startsWith("/inspector")
  );
}

/** The Origin we present upstream on dev-internal paths.
 *
 *  We used to DELETE the header. An absent Origin makes the dev server treat the
 *  request as same-origin — which is exactly the hole the guard exists to close
 *  (cf. CVE-2026-27977, cross-site WebSocket hijacking on the dev HMR socket).
 *  Rewriting to an origin the dev server allowlists by default (`localhost` /
 *  `*.localhost`) keeps HMR working while the proxy asserts an origin it has
 *  actually verified — see `originAllowed`.
 *
 *  Measured on Next 16: the guard compares Origin against its allowlist and does
 *  NOT require it to match Host, so `Host: <preview host>` + `Origin:
 *  http://localhost:<port>` is accepted. */
export function devOriginFor(port: number): string {
  return `http://localhost:${port}`;
}

/** Same-origin check for dev-internal paths — the CSRF defence Next's guard was
 *  trying to give us, enforced where the topology is actually known.
 *
 *  Rewriting the Origin WITHOUT this would be a regression dressed as a fix: a
 *  malicious page's socket arrives as `Origin: https://evil.com` and the rewrite
 *  would launder it into a trusted `localhost`. The HMAC gate does not cover it —
 *  the preview cookie is `SameSite=None` (required for the iframe), so the browser
 *  attaches it to cross-site requests too.
 *
 *  An ABSENT Origin is allowed: non-browser dev clients (an Expo dev client
 *  fetching a bundle) send none, while browsers always send one on WebSocket
 *  upgrades and cross-origin fetches. A literal `null` never matches a host, so
 *  opaque origins are refused for free.
 *
 *  ⚠️ The preview iframe sets `sandbox="allow-same-origin …"` and therefore sends
 *  its real origin. Dropping `allow-same-origin` would make it send `null` and
 *  this check would (correctly) start refusing it. */
export function originAllowed(origin: string | string[] | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (typeof origin !== "string") return false;
  if (!host) return false;
  return origin === `https://${host}` || origin === `http://${host}`;
}
