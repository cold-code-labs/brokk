import type { NextRequest } from "next/server";

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
  const { path = [] } = await ctx.params;
  const target = `${API}/${path.join("/")}${req.nextUrl.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP.has(key.toLowerCase())) headers.set(key, value);
  });

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
