import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getSession } from "../../../lib/logto";

/**
 * Runtime reverse-proxy to the control-plane API under /api (one public origin,
 * no CORS). This REPLACES a `next.config` rewrite on purpose: with
 * `output: "standalone"`, Next freezes a rewrite's destination into
 * routes-manifest.json at *build* time — so `BROKK_API_INTERNAL_URL` set at
 * runtime was ignored and every call hit the build-time default (127.0.0.1),
 * which fails wherever the API isn't on the web container's own loopback
 * (e.g. surtr: API on host-net, reached via host.docker.internal). A route
 * handler reads the env on each request, so the same image works for the
 * bundled compose (http://api:8789) and surtr alike. SSE streams through.
 */
export const dynamic = "force-dynamic";

const API = process.env.BROKK_API_INTERNAL_URL ?? "http://127.0.0.1:8789";
const API_SECRET = process.env.BROKK_API_SECRET ?? "";
// Bearer alternativo ao cookie Logto p/ clientes nativos (Brokk Mobile). O token
// nunca vai no bundle do app — o usuário cola 1x e fica no secure-store do device.
const MOBILE_TOKEN = process.env.BROKK_MOBILE_TOKEN ?? "";

function bearerToken(req: NextRequest): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function bearerOk(req: NextRequest): boolean {
  if (!MOBILE_TOKEN) return false;
  const token = bearerToken(req);
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(MOBILE_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Per-user mobile tokens: BROKK_MOBILE_TOKENS is a JSON map { "<token>": "<email>" }.
// A native client that presents a mapped token is authenticated AS that user — the
// email becomes x-brokk-actor, so chat isolation + per-user seat routing work on
// mobile exactly like the web Logto session. Each teammate pastes their OWN token,
// so no app change is needed. The legacy single BROKK_MOBILE_TOKEN stays a shared
// (identity-less) fallback. Constant-time compare per entry.
const MOBILE_TOKENS: Record<string, string> = (() => {
  try {
    return JSON.parse(process.env.BROKK_MOBILE_TOKENS ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
})();

function mobileActor(req: NextRequest): string | null {
  const token = bearerToken(req);
  if (!token) return null;
  const tb = Buffer.from(token);
  for (const [k, email] of Object.entries(MOBILE_TOKENS)) {
    const kb = Buffer.from(k);
    if (kb.length === tb.length && timingSafeEqual(kb, tb)) return email;
  }
  return null;
}

// Hop-by-hop / length headers must not be forwarded verbatim.
const STRIP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

async function proxy(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  // We capture the caller's email as the trusted actor identity on EVERY request
  // (reads included) so the control-plane can both (a) attribute tasks/chats to a
  // real person for seat routing (see claimNext / Sindri seatCfgFor) and (b)
  // enforce chat privacy on GET /sessions (the list must be filtered to the
  // caller). The client can't spoof it: we overwrite any inbound x-brokk-actor
  // from the server-side Logto session below. Mutations additionally REQUIRE a
  // session — otherwise the secret we inject would let an anonymous caller forge
  // runs through the public origin. Reads stay open (Logto-off dev = open shell).
  const isMutation =
    req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  let actor = "";
  // ADR 0064 — org claims from Logto session (never client-supplied).
  let orgIds = "";
  let isStaff = "0";
  const mobileEmail = mobileActor(req);
  if (mobileEmail) {
    // Per-user mobile token → authenticated AS this user (identity carried).
    // No org claims on the token map yet → not staff; with tenancy on, lists empty
    // until orgs are wired into BROKK_MOBILE_TOKENS (or the user uses web Logto).
    actor = mobileEmail;
    isStaff = "0";
  } else if (bearerOk(req)) {
    // Legacy shared mobile token — identity-less ops fallback (staff).
    isStaff = "1";
  } else {
    // Not the legacy shared mobile token either → require a Logto session for
    // mutations; carry its email as the actor (reads stay open in dev).
    const session = await getSession();
    if (isMutation && !session.isAuthenticated) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    actor = session.email ?? "";
    orgIds = session.organizations.join(",");
    isStaff = session.isCclStaff ? "1" : "0";
  }

  const { path = [] } = await ctx.params;
  const target = `${API}/${path.join("/")}${req.nextUrl.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP.has(key.toLowerCase())) headers.set(key, value);
  });
  // Inject the API secret server-side so mutating calls are authorized. The
  // browser never sees it; a direct caller to the API origin can't forge runs.
  if (API_SECRET) headers.set("authorization", `Bearer ${API_SECRET}`);
  // Trusted actor identity from the Logto session (never client-supplied).
  if (actor) headers.set("x-brokk-actor", actor);
  else headers.delete("x-brokk-actor");
  // Overwrite any inbound spoofed org headers.
  headers.set("x-brokk-org-ids", orgIds);
  headers.set("x-brokk-is-staff", isStaff);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
    ...(hasBody ? { body: req.body, duplex: "half" } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return new Response(`Bad gateway: control-plane API unreachable (${String(e)})`, {
      status: 502,
    });
  }

  // Pass the (possibly streaming, e.g. text/event-stream) body straight through.
  // Drop content-encoding/length: fetch already decoded the body.
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("content-encoding");
  respHeaders.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as HEAD,
  proxy as OPTIONS,
};
