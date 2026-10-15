import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { User } from "../shared/domain.ts";
import type { A4Identity } from "./a4-suite.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import { Problem } from "./store.ts";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
export type Env = {
  Variables: { user: User; a4Identity?: A4Identity; a4Token?: string };
};
export function secretOk(given: string, expected: string) {
  const a = Buffer.from(given),
    b = Buffer.from(expected);
  return Boolean(expected) && a.length === b.length && timingSafeEqual(a, b);
}
export function installAuth(app: Hono<Env>, store: Store, cfg: Config) {
  const cookies = {
    httpOnly: true,
    secure: cfg.production,
    sameSite: "Lax" as const,
    path: "/",
  };
  const put = (c: Context, name: string, value: string, maxAge: number) =>
    setCookie(c, name, value, { ...cookies, maxAge });
  async function session(c: Context, user: User) {
    user.admin = cfg.adminEmails.includes(user.email);
    put(c, "brokk_session", await store.login(user), 43200);
  }
  let metadata:
    | {
        issuer: string;
        authorization_endpoint: string;
        token_endpoint: string;
        jwks_uri: string;
        userinfo_endpoint: string;
      }
    | undefined;
  async function discover() {
    if (metadata) return metadata;
    const response = await fetch(
      `${cfg.oidc.endpoint}/oidc/.well-known/openid-configuration`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) throw new Problem(503, "Identidade indisponível.");
    metadata = await response.json();
    if (!metadata) throw new Problem(503, "Identidade indisponível.");
    return metadata;
  }
  app.get("/api/auth/start", async (c) => {
    if (cfg.suite.authority) return c.redirect("/api/auth/a4/start");
    if (!cfg.oidc.appId)
      throw new Problem(503, "O acesso CCL ID precisa ser configurado.");
    const m = await discover();
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    put(c, "brokk_oidc", JSON.stringify({ state, nonce, verifier }), 600);
    const url = new URL(m.authorization_endpoint);
    url.searchParams.set("client_id", cfg.oidc.appId);
    url.searchParams.set("redirect_uri", `${cfg.origin}/api/auth/callback`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    url.searchParams.set("code_challenge_method", "S256");
    return c.redirect(url.href);
  });
  app.get("/api/auth/callback", async (c) => {
    if (cfg.suite.authority) return c.json({ error: "a4_login_required" }, 401);
    try {
      const saved = JSON.parse(getCookie(c, "brokk_oidc") || "{}") as {
        state: string;
        nonce: string;
        verifier: string;
      };
      deleteCookie(c, "brokk_oidc", cookies);
      const state = c.req.query("state") || "",
        code = c.req.query("code");
      if (!code || !secretOk(state, saved.state || ""))
        throw new Problem(401, "Login inválido.");
      const m = await discover();
      const response = await fetch(m.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
          authorization: `Basic ${Buffer.from(`${cfg.oidc.appId}:${cfg.oidc.secret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${cfg.origin}/api/auth/callback`,
          code_verifier: saved.verifier,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Problem(401, "Login inválido.");
      const tokens = (await response.json()) as {
        id_token: string;
        access_token: string;
      };
      const { payload } = await jwtVerify(
        tokens.id_token,
        createRemoteJWKSet(new URL(m.jwks_uri), {
          headers: { "User-Agent": UA },
        }),
        { issuer: m.issuer, audience: cfg.oidc.appId },
      );
      if (payload.nonce !== saved.nonce || !payload.sub)
        throw new Problem(401, "Login inválido.");
      const profileRes = await fetch(m.userinfo_endpoint, {
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "User-Agent": UA,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!profileRes.ok) throw new Problem(401, "Identidade inválida.");
      const profile = (await profileRes.json()) as {
        sub: string;
        email: string;
        name?: string;
        email_verified?: boolean;
      };
      if (
        profile.sub !== payload.sub ||
        !profile.email ||
        profile.email_verified === false
      )
        throw new Problem(401, "E-mail verificado necessário.");
      await session(c, {
        id: payload.sub,
        email: profile.email.toLowerCase(),
        name: profile.name || profile.email,
        admin: false,
      });
      return c.redirect("/");
    } catch {
      return c.redirect("/?login=failed");
    }
  });
  app.post("/api/auth/dev", async (c) => {
    if (!cfg.devAuth || cfg.production)
      return c.json({ error: "not_found" }, 404);
    const input = (await c.req.json().catch(() => ({}))) as { email?: string };
    const email = String(input.email || "admin@local.test").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)
      throw new Problem(400, "E-mail inválido.");
    await session(c, {
      id: `local:${email}`,
      email,
      name: email.split("@")[0],
      admin: false,
    });
    return c.json({ ok: true });
  });
  app.get("/api/auth/handoff", async (c) => {
    const result = await store.redeem(c.req.query("ticket") || "");
    await session(c, result.user);
    return c.redirect(`/projects/${result.projectId}`);
  });
  app.use("/api/*", async (c, next) => {
    if (
      c.req.path === "/api/health" ||
      c.req.path === "/api/integrations/var/handoff"
    )
      return next();
    if (cfg.suite.authority) {
      const identity = c.get("a4Identity");
      if (!identity) return c.json({ error: "a4_login_required" }, 401);
      const organization = await store.suiteOrganization(
        identity.organization.id,
        identity.organization.name,
        identity.user.email,
        identity.organization.role === "viewer" ? "reader" : "operator",
      );
      c.set("user", {
        id: identity.user.id,
        email: identity.user.email,
        name: identity.user.name || identity.user.email,
        admin: cfg.adminEmails.includes(identity.user.email),
        suiteOrganization: organization,
        suiteToken: c.get("a4Token"),
      });
      return next();
    }
    const token = getCookie(c, "brokk_session");
    const user = token ? await store.session(token) : undefined;
    if (!user) {
      if (c.req.path === "/api/me")
        return c.json({ user: null, devAuth: cfg.devAuth });
      return c.json({ error: "Entre para acessar o Brokk." }, 401);
    }
    user.admin = cfg.adminEmails.includes(user.email);
    c.set("user", user);
    await next();
  });
  app.get("/api/me", (c) =>
    c.json({
      user: (({ id, email, name, admin }) => ({ id, email, name, admin }))(
        c.get("user"),
      ),
      a4Authority: cfg.suite.authority || undefined,
      devAuth: cfg.devAuth,
      integrations: {
        devin: Boolean(cfg.devin.key && cfg.devin.orgId),
        cursor: Boolean(cfg.coder.workerSecret),
        calls: Boolean(cfg.daily.key),
        var: Boolean(cfg.varSecret),
      },
    }),
  );
  app.post("/api/auth/logout", async (c) => {
    await store.logout(getCookie(c, "brokk_session") || "");
    deleteCookie(c, "brokk_session", cookies);
    return c.json({ ok: true });
  });
}
