import { Hono } from "hono";
import type { AppDeps } from "../app.js";

/**
 * Chat proxy → Sindri. Keeps ONE public origin: the browser hits the web's
 * /api/chat/* proxy, which forwards to this control-plane route, which forwards to
 * the Sindri runtime on the worker host (git/gh/checkouts live there, not here).
 * SSE streams straight through both hops. Sindri trusts the runner secret.
 *
 * Why proxy instead of mounting the runtime here: the API container is light and
 * has no git/gh/repo checkouts; Sindri runs alongside the forge runner where they do.
 */
const STRIP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length"]);

export function chatRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  const base = (deps.sindriUrl ?? "").replace(/\/$/, "");

  if (!base) {
    r.all("/*", (c) => c.json({ error: "chat is not configured (BROKK_SINDRI_URL unset)" }, 503));
    return r;
  }

  r.all("/*", async (c) => {
    // c.req.path is the full path (/chat/...). Strip the mount prefix for Sindri.
    const suffix = c.req.path.replace(/^\/chat/, "");
    const target = `${base}${suffix}${c.req.url.includes("?") ? `?${c.req.url.split("?")[1]}` : ""}`;

    const headers = new Headers();
    c.req.raw.headers.forEach((v, k) => {
      if (!STRIP.has(k.toLowerCase()) && k.toLowerCase() !== "authorization") headers.set(k, v);
    });
    // Authenticate to Sindri with the shared runner secret (server-side only).
    if (deps.runnerSecret) headers.set("authorization", `Bearer ${deps.runnerSecret}`);

    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: c.req.method,
        headers,
        ...(hasBody ? { body: c.req.raw.body, duplex: "half" } : {}),
      } as RequestInit);
    } catch (e) {
      return c.json({ error: `sindri unreachable: ${String(e)}` }, 502);
    }

    const respHeaders = new Headers(upstream.headers);
    respHeaders.delete("content-encoding");
    respHeaders.delete("content-length");
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  });

  return r;
}
