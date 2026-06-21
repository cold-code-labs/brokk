/**
 * @brokk/gateway — *.preview reverse proxy
 *
 * Routes *.preview.coldcodelabs.com traffic to the correct local preview port
 * based on the subdomain. Resolves subdomains via the Brokk control plane
 * (/previews), caches the mapping for ~5 s, and bumps the TTL of active
 * previews so a live demo never gets reaped mid-show.
 *
 * ─── One-time infra wiring (human sets this up, not code) ───────────────────
 *
 *  1. Cloudflare Tunnel on surtr:
 *     - Wildcard CNAME: *.preview.coldcodelabs.com → <tunnel-id>.cfargotunnel.com
 *     - Tunnel ingress rule: *.preview.coldcodelabs.com → http://localhost:3020
 *       (i.e. this gateway process)
 *
 *  2. Start this service as a systemd unit on surtr:
 *       ExecStart=node /opt/brokk/gateway/dist/index.js
 *       Environment=BROKK_RUNNER_SECRET=<secret>
 *       Environment=BROKK_CONTROL_URL=http://127.0.0.1:8789
 *
 *  The gateway itself is plain HTTP on :3020; the CF tunnel handles TLS.
 *
 * ─── Request flow ───────────────────────────────────────────────────────────
 *
 *  brokk-dev.preview.coldcodelabs.com
 *    → CF tunnel → this gateway :3020
 *    → extract leftmost label "brokk-dev"
 *    → look up in preview cache (refresh from control plane every 5 s)
 *    → proxy to http://127.0.0.1:<port>  (HTTP + WebSocket)
 *    → bump expiresAt on the preview (at most once per 60 s) so active demos
 *      keep sliding their TTL
 *
 * ─── Error pages ────────────────────────────────────────────────────────────
 *
 *  404  No live preview matches the subdomain (not found or status !== "live").
 *  502  Upstream port refused the connection (preview starting / crashed).
 */

import * as http from "node:http";
import * as net from "node:net";
import { loadConfig } from "./config.js";

const cfg = loadConfig();

// ── Control-plane HTTP helpers ────────────────────────────────────────────────

/** Parse the host/port from a URL string into options suitable for http.*. */
function parseBaseUrl(raw: string): { hostname: string; port: number } {
  const u = new URL(raw);
  return {
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80,
  };
}

const cpBase = parseBaseUrl(cfg.BROKK_CONTROL_URL);

/** GET <control-plane>/previews and return the parsed JSON array. */
function fetchPreviews(): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: cpBase.hostname,
        port: cpBase.port,
        path: "/previews",
        headers: { Authorization: `Bearer ${cfg.BROKK_RUNNER_SECRET}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!Array.isArray(parsed)) {
              reject(new Error("control plane returned non-array"));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });
}

/**
 * Fire-and-forget PATCH /previews/:id to slide the TTL forward.
 * Errors are logged but never propagate — a missed bump is non-fatal.
 */
function patchPreviewTtl(id: string, expiresAt: string): void {
  const payload = JSON.stringify({ expiresAt });
  const req = http.request(
    {
      hostname: cpBase.hostname,
      port: cpBase.port,
      path: `/previews/${id}`,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Authorization: `Bearer ${cfg.BROKK_RUNNER_SECRET}`,
      },
    },
    (res) => {
      res.resume(); // drain and discard
    },
  );
  req.on("error", (err) => {
    console.error(`[gateway] activity bump PATCH /previews/${id} failed:`, err.message);
  });
  req.write(payload);
  req.end();
}

// ── Preview cache (subdomain → port + id) ────────────────────────────────────

interface CacheEntry {
  port: number;
  id: string;
}

/** Milliseconds the subdomain→port map is considered fresh before re-fetching. */
const CACHE_TTL_MS = 5_000;

let cache: Map<string, CacheEntry> = new Map();
let cacheTs = 0; // epoch ms of last successful refresh

/**
 * Return the current cache map, refreshing it from the control plane if stale.
 * On refresh error the stale map is returned so transient CP outages don't
 * immediately break in-flight requests.
 */
async function resolveCache(): Promise<Map<string, CacheEntry>> {
  const now = Date.now();
  if (now - cacheTs < CACHE_TTL_MS) return cache;

  try {
    const previews = await fetchPreviews();
    const next = new Map<string, CacheEntry>();
    for (const p of previews) {
      if (
        p !== null &&
        typeof p === "object" &&
        "status" in p &&
        p.status === "live" &&
        "subdomain" in p &&
        typeof p.subdomain === "string" &&
        "port" in p &&
        typeof p.port === "number" &&
        "id" in p &&
        typeof p.id === "string"
      ) {
        next.set(p.subdomain, { port: p.port, id: p.id });
      }
    }
    cache = next;
    cacheTs = now;
    console.log(`[gateway] cache refreshed — ${next.size} live preview(s)`);
  } catch (err) {
    console.error("[gateway] cache refresh failed (serving stale):", err instanceof Error ? err.message : err);
  }

  return cache;
}

// ── Activity bump (at most once per 60 s per preview id) ─────────────────────

const BUMP_THROTTLE_MS = 60_000;
const lastBumpAt = new Map<string, number>();

function maybeBump(id: string): void {
  const now = Date.now();
  const last = lastBumpAt.get(id) ?? 0;
  if (now - last < BUMP_THROTTLE_MS) return;
  lastBumpAt.set(id, now);

  const expiresAt = new Date(now + cfg.BROKK_PREVIEW_TTL_MS).toISOString();
  patchPreviewTtl(id, expiresAt);
}

// ── Static HTML error pages ───────────────────────────────────────────────────

const STYLE = `
  body {
    font-family: system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    background: #f8f9fa;
  }
  .card {
    text-align: center;
    padding: 2.5rem 3rem;
    background: #fff;
    border-radius: 10px;
    box-shadow: 0 2px 12px rgba(0,0,0,.08);
    max-width: 420px;
  }
  h1 { font-size: 1.4rem; margin: 0 0 .6rem; color: #111; }
  p  { color: #555; margin: 0; line-height: 1.5; }
`.trim();

const HTML_404 = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>No preview running</title>
<style>${STYLE}</style></head>
<body>
  <div class="card">
    <h1>No preview running</h1>
    <p>There is no active preview environment for this URL.<br>
       Start a preview from the Brokk board first.</p>
  </div>
</body>
</html>`;

const HTML_502 = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Preview starting…</title>
<style>${STYLE}</style></head>
<body>
  <div class="card">
    <h1>Preview starting…</h1>
    <p>The preview environment is starting up or temporarily unreachable.<br>
       Try again in a few seconds.</p>
  </div>
</body>
</html>`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the leftmost DNS label from the Host header, e.g. "brokk-dev". */
function subdomainFrom(req: http.IncomingMessage): string | null {
  const host = req.headers.host ?? "";
  const label = host.split(".")[0] ?? "";
  return label.length > 0 ? label : null;
}

function respondHtml(res: http.ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ── HTTP reverse proxy ────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Kick off async handling; catch top-level errors to prevent crashes.
  handleRequest(req, res).catch((err) => {
    console.error("[gateway] unhandled error in HTTP handler:", err);
    respondHtml(res, 502, HTML_502);
  });
});

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const subdomain = subdomainFrom(req);
  if (!subdomain) {
    respondHtml(res, 404, HTML_404);
    return;
  }

  const entries = await resolveCache();
  const entry = entries.get(subdomain);
  if (!entry) {
    respondHtml(res, 404, HTML_404);
    return;
  }

  maybeBump(entry.id);

  // Forward the request to the upstream preview process.
  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: entry.port,
      method: req.method,
      path: req.url ?? "/",
      headers: req.headers,
    },
    (proxyRes) => {
      if (res.headersSent) return;
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
      proxyRes.on("error", () => res.destroy());
    },
  );

  proxyReq.on("error", () => respondHtml(res, 502, HTML_502));
  req.pipe(proxyReq, { end: true });
  req.on("error", () => proxyReq.destroy());
}

// ── WebSocket upgrade proxy ───────────────────────────────────────────────────

server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
  socket.on("error", () => socket.destroy());

  handleUpgrade(req, socket, head).catch((err) => {
    console.error("[gateway] unhandled error in WebSocket handler:", err);
    if (!socket.destroyed) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    }
  });
});

async function handleUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): Promise<void> {
  const subdomain = subdomainFrom(req);
  if (!subdomain) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const entries = await resolveCache();
  const entry = entries.get(subdomain);
  if (!entry) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  maybeBump(entry.id);

  // Open a raw TCP connection to the upstream preview process and replay the
  // HTTP upgrade handshake so the upstream's WebSocket server can respond.
  const upstream = net.createConnection(entry.port, "127.0.0.1");

  upstream.on("error", () => {
    if (!socket.destroyed) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    }
  });

  upstream.once("connect", () => {
    // Reconstruct and send the original HTTP upgrade request.
    const headerLines = Object.entries(req.headers)
      .flatMap(([k, v]) =>
        Array.isArray(v) ? v.map((val) => `${k}: ${val}`) : [`${k}: ${v}`],
      )
      .join("\r\n");
    upstream.write(`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);

    // Bidirectional pipe — from this point it is pure WebSocket framing.
    upstream.pipe(socket, { end: true });
    socket.pipe(upstream, { end: true });

    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

server.listen(cfg.BROKK_GATEWAY_PORT, "0.0.0.0", () => {
  console.log(
    `[gateway] *.preview reverse proxy listening on :${cfg.BROKK_GATEWAY_PORT}`,
  );
  console.log(`[gateway] control plane: ${cfg.BROKK_CONTROL_URL}`);
  console.log(`[gateway] preview TTL bump: ${cfg.BROKK_PREVIEW_TTL_MS} ms`);
});

server.on("error", (err) => {
  console.error("[gateway] server error:", err);
  process.exit(1);
});
