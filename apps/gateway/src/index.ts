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

/** A resolved control plane the gateway talks to. */
interface CpBase {
  hostname: string;
  port: number;
  /** Host to dial this plane's preview processes on (see BROKK_PREVIEW_HOST_MAP).
   *  Planes can live on different hosts — prod previews inside the `forge`
   *  container, dev-lane previews on the host — so it's resolved per plane. */
  previewHost: string;
}

/** Parse the host/port from a URL string into options suitable for http.*. */
function parseBaseUrl(raw: string): CpBase {
  const u = new URL(raw);
  return {
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80,
    previewHost: cfg.previewHostFor(u.hostname),
  };
}

/** All control planes, primary (prod) first. The gateway is the singleton that
 *  serves the public *.preview domain, so it merges previews across planes (e.g.
 *  prod :8789 + dev-lane :8790) — same host, same shared secret, disjoint ports. */
const cpBases: CpBase[] = cfg.controlUrls.map(parseBaseUrl);

/** GET <control-plane>/previews from ONE plane and return the parsed JSON array. */
function fetchPreviewsFrom(cp: CpBase): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: cp.hostname,
        port: cp.port,
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

/** A preview row paired with the control plane it came from (for bump/wake). */
type TaggedPreview = { row: Record<string, unknown>; cp: CpBase };

/** Fetch previews from every control plane and merge. A plane that errors is
 *  skipped (logged) so one lane being down never breaks the others. */
async function fetchAllPreviews(): Promise<TaggedPreview[]> {
  const results = await Promise.allSettled(cpBases.map((cp) => fetchPreviewsFrom(cp)));
  const out: TaggedPreview[] = [];
  results.forEach((r, i) => {
    const cp = cpBases[i]!;
    if (r.status === "fulfilled") {
      for (const row of r.value) {
        if (row && typeof row === "object") out.push({ row: row as Record<string, unknown>, cp });
      }
    } else {
      console.error(
        `[gateway] /previews from ${cp.hostname}:${cp.port} failed (skipping):`,
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
    }
  });
  return out;
}

/**
 * Fire-and-forget PATCH /previews/:id to slide the TTL forward.
 * Errors are logged but never propagate — a missed bump is non-fatal.
 */
function patchPreviewTtl(id: string, expiresAt: string, cp: CpBase): void {
  const payload = JSON.stringify({ expiresAt });
  const req = http.request(
    {
      hostname: cp.hostname,
      port: cp.port,
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

/**
 * Fire-and-forget POST /previews to wake a reaped (stopped) preview when a
 * visitor lands on its URL. Idempotent on the control plane — an already-starting
 * preview is returned, not duplicated — so a repeat hit during the thaw is safe.
 */
function firePreview(projectId: string, branch: string, cp: CpBase): void {
  const payload = JSON.stringify({ projectId, branch });
  const req = http.request(
    {
      hostname: cp.hostname,
      port: cp.port,
      path: "/previews",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Authorization: `Bearer ${cfg.BROKK_RUNNER_SECRET}`,
      },
    },
    (res) => res.resume(),
  );
  req.on("error", (err) => {
    console.error(`[gateway] wake POST /previews failed:`, err.message);
  });
  req.write(payload);
  req.end();
}

// ── Preview cache (subdomain → port + id) ────────────────────────────────────

interface CacheEntry {
  port: number;
  id: string;
  /** Which control plane owns this preview — bumps/wakes must target it. */
  cp: CpBase;
}

/** Milliseconds the subdomain→port map is considered fresh before re-fetching. */
const CACHE_TTL_MS = 5_000;

let cache: Map<string, CacheEntry> = new Map();
let cacheTs = 0; // epoch ms of last successful refresh

/** Every known preview (any status) by subdomain → how to wake it. Lets the
 *  gateway auto-fire a reaped preview when a visitor lands on its URL. */
let wakeable: Map<string, { projectId: string; branch: string; cp: CpBase }> = new Map();

/**
 * Return the current cache map, refreshing it from the control plane if stale.
 * On refresh error the stale map is returned so transient CP outages don't
 * immediately break in-flight requests.
 */
async function resolveCache(): Promise<Map<string, CacheEntry>> {
  const now = Date.now();
  if (now - cacheTs < CACHE_TTL_MS) return cache;

  try {
    const previews = await fetchAllPreviews();
    const next = new Map<string, CacheEntry>();
    const nextWake = new Map<string, { projectId: string; branch: string; cp: CpBase }>();
    for (const { row: p, cp } of previews) {
      if (!("subdomain" in p) || typeof p.subdomain !== "string") continue;
      const subdomain = p.subdomain;
      // Any preview (live or not) is wakeable as long as we know its project +
      // branch. First plane (prod) wins on the rare cross-plane subdomain clash.
      if (
        !nextWake.has(subdomain) &&
        "projectId" in p &&
        typeof p.projectId === "string" &&
        "branch" in p &&
        typeof p.branch === "string"
      ) {
        nextWake.set(subdomain, { projectId: p.projectId, branch: p.branch, cp });
      }
      if (
        !next.has(subdomain) &&
        "status" in p &&
        p.status === "live" &&
        "port" in p &&
        typeof p.port === "number" &&
        "id" in p &&
        typeof p.id === "string"
      ) {
        next.set(subdomain, { port: p.port, id: p.id, cp });
      }
    }
    cache = next;
    wakeable = nextWake;
    cacheTs = now;
    console.log(
      `[gateway] cache refreshed — ${next.size} live preview(s), ${nextWake.size} wakeable across ${cpBases.length} plane(s)`,
    );
  } catch (err) {
    console.error("[gateway] cache refresh failed (serving stale):", err instanceof Error ? err.message : err);
  }

  return cache;
}

// ── Activity bump (at most once per 60 s per preview id) ─────────────────────

const BUMP_THROTTLE_MS = 60_000;
const lastBumpAt = new Map<string, number>();

function maybeBump(id: string, cp: CpBase): void {
  const now = Date.now();
  const last = lastBumpAt.get(id) ?? 0;
  if (now - last < BUMP_THROTTLE_MS) return;
  lastBumpAt.set(id, now);

  const expiresAt = new Date(now + cfg.BROKK_PREVIEW_TTL_MS).toISOString();
  patchPreviewTtl(id, expiresAt, cp);
}

// ── Auto-wake (at most once per 15 s per subdomain) ──────────────────────────

const WAKE_THROTTLE_MS = 15_000;
const lastWakeAt = new Map<string, number>();

function maybeWake(subdomain: string, projectId: string, branch: string, cp: CpBase): void {
  const now = Date.now();
  if (now - (lastWakeAt.get(subdomain) ?? 0) < WAKE_THROTTLE_MS) return;
  lastWakeAt.set(subdomain, now);
  console.log(`[gateway] waking ${subdomain} (project ${projectId}, branch ${branch})`);
  firePreview(projectId, branch, cp);
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

/** Escape the few chars that matter in HTML text/attributes. The Host header is
 *  attacker-controllable, so the echoed domain must never be injected raw. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Falling snow — a fixed set of flakes with index-derived position/size/timing,
// precomputed once so the 404 handler is allocation-free. Pure CSS, no JS.
const SNOW = Array.from({ length: 16 }, (_, i) => {
  const left = (i * 6.25 + 2) % 100;
  const dur = 7 + (i % 6);
  const delay = i % 8;
  const size = 9 + (i % 4) * 4;
  const op = (0.35 + (i % 4) * 0.18).toFixed(2);
  return `<i class="flk" style="left:${left}%;font-size:${size}px;animation-duration:${dur}s;animation-delay:-${delay}s;opacity:${op}">❄</i>`;
}).join("");

// Cold-themed "domain not found" page. On-brand for Cold Code Labs (the Brokk
// "Forge at Night" deep-freeze palette) and it ECHOES the domain that missed, so
// a typo like `maglin.preview…` reads back at the visitor instead of a generic
// dead end. Self-contained, no external deps.
function html404(host: string): string {
  const safe = escapeHtml(host && host.length > 0 ? host : "este endereço");
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Domínio congelado · 404</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; margin:0;
    min-height:100vh; display:flex; align-items:center; justify-content:center; overflow:hidden;
    background: radial-gradient(120% 120% at 50% -10%, #14395d 0%, #0c2740 45%, #071a2c 100%);
    color:#eaf3fc; }
  .flk { position:fixed; top:-6%; color:#cfe4fa; pointer-events:none; user-select:none;
    animation-name: fall; animation-timing-function: linear; animation-iteration-count: infinite; }
  @keyframes fall { to { transform: translateY(112vh) rotate(360deg); } }
  .card { position:relative; z-index:1; text-align:center; padding:3rem 2.6rem; max-width:480px; }
  .snowman { font-size:4.6rem; line-height:1; margin-bottom:1.2rem; display:inline-block;
    filter: drop-shadow(0 6px 18px rgba(0,0,0,.45));
    animation: bob 3.2s ease-in-out infinite, shiver 5s ease-in-out infinite; }
  @keyframes bob { 0%,100%{ transform: translateY(0); } 50%{ transform: translateY(-7px); } }
  @keyframes shiver { 0%,88%,100%{ transform: rotate(0); } 92%{ transform: rotate(-4deg); } 96%{ transform: rotate(4deg); } }
  .tag { display:inline-block; font-size:.72rem; letter-spacing:.18em; text-transform:uppercase;
    color:#7fb0e3; border:1px solid rgba(127,176,227,.35); border-radius:999px; padding:.28rem .8rem; margin-bottom:1.2rem; }
  h1 { font-size:1.55rem; font-weight:600; margin:0 0 .7rem; }
  p  { color:#b9d2ec; margin:0 0 .5rem; line-height:1.6; font-size:1.04rem; }
  code { display:inline-block; margin-top:.35rem; font-size:.96rem; color:#eaf3fc;
    background: rgba(255,255,255,.07); border:1px solid rgba(180,210,240,.22);
    border-radius:8px; padding:.4rem .7rem; word-break:break-all;
    box-shadow: inset 0 0 22px rgba(120,170,220,.12); }
  .hint { margin-top:1.5rem; font-size:.94rem; color:#86a6c6; }
</style>
</head>
<body>
  ${SNOW}
  <div class="card">
    <div class="snowman">☃️</div>
    <span class="tag">404 · só neve por aqui</span>
    <h1>Esse endereço congelou</h1>
    <p>Vasculhamos o glaciar inteiro e não encontramos nenhum preview em</p>
    <p><code>${safe}</code></p>
    <p class="hint">Será que escapou uma letrinha no meio da nevasca? ❄️<br>
       Confere o endereço e tenta de novo — ou inicia um preview no board do Brokk.</p>
  </div>
</body>
</html>`;
}

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

// Friendly, client-facing "we're warming this up" page. Served when a visitor
// lands on a reaped/starting preview — the gateway fires the wake in the
// background and this page auto-refreshes until the app answers. On-brand for
// Cold Code Labs (the environment is "thawing"). Self-contained, no external deps.
const HTML_THAWING = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="4">
<title>Preparando seu preview…</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; margin:0;
    min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#eef4fb; color:#0c2740; }
  .card { text-align:center; padding:3rem 2.5rem; max-width:440px; }
  .flake { width:54px; height:54px; margin:0 auto 1.7rem; position:relative;
    animation: spin 3.4s linear infinite, pulse 1.9s ease-in-out infinite; }
  .flake span { position:absolute; inset:0; }
  .flake span::before { content:""; position:absolute; left:50%; top:0; width:3px; height:100%;
    margin-left:-1.5px; border-radius:3px; background:#5b9bdc; }
  .flake span:nth-child(2){ transform:rotate(60deg); }
  .flake span:nth-child(3){ transform:rotate(120deg); }
  @keyframes spin { to { transform:rotate(360deg); } }
  @keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:1} }
  h1 { font-size:1.4rem; font-weight:600; margin:0 0 .6rem; }
  p  { color:#3e5d78; margin:0; line-height:1.6; font-size:1.02rem; }
  .bar { margin:1.9rem auto 0; width:210px; height:5px; border-radius:5px; background:#d6e4f4; overflow:hidden; }
  .bar i { display:block; height:100%; width:40%; border-radius:5px; background:#3a82d6;
    animation: slide 1.5s ease-in-out infinite; }
  @keyframes slide { 0%{transform:translateX(-110%)} 100%{transform:translateX(380%)} }
</style>
</head>
<body>
  <div class="card">
    <div class="flake"><span></span><span></span><span></span></div>
    <h1>Preparando seu preview</h1>
    <p>Estamos descongelando o ambiente — leva só alguns segundos.<br>
       Esta página abre sozinha assim que estiver pronto.</p>
    <div class="bar"><i></i></div>
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
    "Cache-Control": "no-store",
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
    respondHtml(res, 404, html404(req.headers.host ?? ""));
    return;
  }

  const entries = await resolveCache();
  const entry = entries.get(subdomain);
  if (!entry) {
    // No LIVE preview. If we know how to wake this one (a reaped/starting row
    // exists for the subdomain), fire it in the background and show the friendly
    // "thawing" page that auto-refreshes until the app answers. Only a subdomain
    // we've never seen falls through to the real not-found page.
    const wake = wakeable.get(subdomain);
    if (wake) {
      maybeWake(subdomain, wake.projectId, wake.branch, wake.cp);
      respondHtml(res, 200, HTML_THAWING);
      return;
    }
    respondHtml(res, 404, html404(req.headers.host ?? ""));
    return;
  }

  maybeBump(entry.id, entry.cp);

  // Forward the request to the upstream preview process — on the host that owns
  // this preview's control plane (planes can run on different hosts).
  const proxyReq = http.request(
    {
      hostname: entry.cp.previewHost,
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

  proxyReq.on("error", () => {
    // Upstream unreachable: the preview can be marked "live" a beat before Next
    // is actually listening (cold start), or it was just reaped. Serve the
    // thawing page (200, auto-refreshes) instead of a hard 502 — a 502 gets
    // replaced by Cloudflare's own non-refreshing error page, stranding the
    // visitor. Nudge the wake in case the process is gone, and let the page
    // self-recover on its next refresh once the app answers.
    const w = wakeable.get(subdomain);
    if (w) maybeWake(subdomain, w.projectId, w.branch, w.cp);
    respondHtml(res, 200, HTML_THAWING);
  });
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

  maybeBump(entry.id, entry.cp);

  // Open a raw TCP connection to the upstream preview process and replay the
  // HTTP upgrade handshake so the upstream's WebSocket server can respond. Dial
  // the host that owns this preview's plane (HMR rides this WS — it must reach
  // the same upstream as the HTTP proxy above).
  const upstream = net.createConnection(entry.port, entry.cp.previewHost);

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
  console.log(`[gateway] control plane(s): ${cfg.controlUrls.join(", ")}`);
  console.log(
    `[gateway] preview host(s): ${cpBases
      .map((cp) => `${cp.hostname}→${cp.previewHost}`)
      .join(", ")}`,
  );
  console.log(`[gateway] preview TTL bump: ${cfg.BROKK_PREVIEW_TTL_MS} ms`);
});

server.on("error", (err) => {
  console.error("[gateway] server error:", err);
  process.exit(1);
});
