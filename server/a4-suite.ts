// A4-owned sessions: one-use PKCE handoff, host-only cookies, live authorization on every request.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
export type A4Identity = {
  user: {
    id: string;
    email: string;
    name: string | null;
    avatar?: string | null;
  };
  organization: {
    id: string;
    name: string;
    role: "owner" | "admin" | "member" | "viewer";
  };
  expiresAt: string;
  isTeam?: boolean;
};
export type A4Client = {
  app: string;
  authority: string;
  origin: string;
  secret: string;
  prefix: string;
};
const opaque = (s: unknown): s is string =>
  typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);
const nonce = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
export const appCookie = (config: A4Client) =>
  config.origin.startsWith("https://") ? "__Host-a4_app" : "a4_app";
const flowCookie = (config: A4Client) =>
  config.origin.startsWith("https://") ? "__Host-a4_flow" : "a4_flow";
const attributes = (config: A4Client) => ({
  httpOnly: true,
  secure: config.origin.startsWith("https://"),
  sameSite: "Lax" as const,
  path: "/",
});
function safePath(path: string | undefined, origin: string) {
  if (!path?.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path))
    return "/";
  const parsed = new URL(path, origin);
  if (
    parsed.origin !== new URL(origin).origin ||
    /^\/api\/(v1\/)?auth\//.test(parsed.pathname)
  )
    return "/";
  return parsed.pathname + parsed.search;
}
function validIdentity(data: unknown): data is A4Identity {
  const d = data as A4Identity;
  return Boolean(
    d?.user &&
      /^[0-9a-f-]{36}$/i.test(d.user.id) &&
      typeof d.user.email === "string" &&
      d.organization &&
      /^[0-9a-f-]{36}$/i.test(d.organization.id) &&
      typeof d.organization.name === "string" &&
      ["owner", "admin", "member", "viewer"].includes(d.organization.role) &&
      Date.parse(d.expiresAt) > Date.now(),
  );
}
export async function a4Request(
  config: A4Client,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${config.authority}/api/suite/${config.app}/${path}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: {
      authorization: `Bearer ${config.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
export async function a4Identity(
  config: A4Client,
  token: string,
): Promise<A4Identity | null> {
  if (!opaque(token)) return null;
  const r = await a4Request(config, "session", { token });
  if (r.status === 401) return null;
  if (!r.ok) throw new Error("a4_unavailable");
  const data: unknown = await r.json();
  if (!validIdentity(data)) throw new Error("a4_invalid_identity");
  return data;
}
export function a4Session(
  config: A4Client,
  options: {
    bypass?: (c: Context) => boolean;
    run?: (
      identity: A4Identity,
      token: string,
      next: () => Promise<void>,
    ) => Promise<void>;
    loginPaths?: string[];
    logoutPaths?: string[];
    legacyCallbacks?: string[];
  } = {},
): MiddlewareHandler {
  return async (c, next) => {
    if (!config.authority) return next();
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    if (options.bypass?.(c)) return next();
    if (
      config.secret.length < 32 ||
      (!config.authority.startsWith("https://") &&
        !config.authority.startsWith("http://127.0.0.1:"))
    )
      return c.json({ error: "a4_not_configured" }, 503);
    const path = c.req.path,
      origin = c.req.header("origin");
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      (c.req.header("sec-fetch-site") === "cross-site" ||
        (origin && origin !== config.origin))
    )
      return c.json({ error: "forbidden_origin" }, 403);
    if (
      path === `${config.prefix}/start` ||
      options.loginPaths?.includes(path)
    ) {
      const state = nonce(),
        verifier = nonce(),
        org = c.req.query("org"),
        url = new URL(`${config.authority}/api/suite/${config.app}/authorize`);
      url.searchParams.set("state", state);
      url.searchParams.set(
        "challenge",
        createHash("sha256").update(verifier).digest("base64url"),
      );
      if (org && /^[0-9a-f-]{36}$/i.test(org)) url.searchParams.set("org", org);
      setCookie(
        c,
        flowCookie(config),
        Buffer.from(
          JSON.stringify({
            state,
            verifier,
            returnPath: safePath(c.req.query("return"), config.origin),
          }),
        ).toString("base64url"),
        { ...attributes(config), maxAge: 600 },
      );
      return c.redirect(url.toString());
    }
    if (path === `${config.prefix}/callback`) {
      const raw = getCookie(c, flowCookie(config));
      deleteCookie(c, flowCookie(config), attributes(config));
      let flow: { state?: string; verifier?: string; returnPath?: string } = {};
      try {
        flow = JSON.parse(Buffer.from(raw ?? "", "base64url").toString());
      } catch {
        /* Fail closed. */
      }
      const code = c.req.query("code"),
        state = c.req.query("state");
      if (
        !opaque(code) ||
        !opaque(state) ||
        !opaque(flow.state) ||
        !opaque(flow.verifier) ||
        !equal(state, flow.state)
      )
        return c.json({ error: "a4_invalid_state" }, 401);
      try {
        const r = await a4Request(config, "exchange", {
          code,
          verifier: flow.verifier,
        });
        if (!r.ok)
          return c.json(
            { error: "a4_exchange_failed" },
            r.status === 401 ? 401 : 503,
          );
        const data = (await r.json()) as A4Identity & { token: string };
        if (!opaque(data.token) || !validIdentity(data))
          return c.json({ error: "a4_exchange_failed" }, 503);
        setCookie(c, appCookie(config), data.token, {
          ...attributes(config),
          maxAge: Math.max(
            1,
            Math.floor((Date.parse(data.expiresAt) - Date.now()) / 1000),
          ),
        });
        return c.redirect(safePath(flow.returnPath, config.origin));
      } catch {
        return c.json({ error: "a4_unavailable" }, 503);
      }
    }
    if (options.legacyCallbacks?.includes(path))
      return c.json({ error: "a4_login_required" }, 401);
    if (options.logoutPaths?.includes(path)) {
      if (c.req.method === "GET")
        return c.redirect(`${config.authority}/assistentes`);
      if (c.req.method !== "POST")
        return c.json({ error: "method_not_allowed" }, 405);
      deleteCookie(c, appCookie(config), attributes(config));
      return c.json({ ok: true, redirect: `${config.authority}/assistentes` });
    }
    const token = getCookie(c, appCookie(config)) ?? "";
    let identity: A4Identity | null = null;
    try {
      identity = await a4Identity(config, token);
    } catch {
      return c.json({ error: "a4_unavailable" }, 503);
    }
    if (!identity) {
      deleteCookie(c, appCookie(config), attributes(config));
      if (path === `${config.prefix}/check` || path.startsWith("/api/"))
        return c.json(
          { error: "a4_login_required", loginUrl: `${config.prefix}/start` },
          401,
        );
      return c.redirect(
        `${config.prefix}/start?return=${encodeURIComponent(safePath(new URL(c.req.url).pathname + new URL(c.req.url).search, config.origin))}`,
      );
    }
    if (path === `${config.prefix}/check`) return c.body(null, 204);
    c.set("a4Identity", identity);
    c.set("a4Token", token);
    if (
      identity.organization.role === "viewer" &&
      !["GET", "HEAD"].includes(c.req.method)
    )
      return c.json({ error: "read_only" }, 403);
    if (options.run) return options.run(identity, token, next);
    return next();
  };
}
