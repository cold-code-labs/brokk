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

function bearerOk(req: NextRequest): boolean {
  if (!MOBILE_TOKEN) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(MOBILE_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
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
  // Mutations require a logged-in human (Logto session). Otherwise the secret the
  // proxy injects below would let any anonymous caller create/enqueue forge runs
  // through the public origin. Reads stay open. Logto-off (dev) = open shell.
  // We also capture the caller's email as the actor identity so the control-plane
  // can attribute the task to a real person (seat routing: a task claims its
  // owner's Max seat first — see claimNext). The client can't spoof it: we
  // overwrite any inbound x-brokk-actor from the trusted server-side session.
  let actor = "";
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && !bearerOk(req)) {
    const session = await getSession();
    if (!session.isAuthenticated) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    actor = session.email ?? "";
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
