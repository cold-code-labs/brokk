import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { type A4Identity, a4Session } from "../server/a4-suite.ts";

test("A4 handoff binds state and PKCE, rejects legacy sessions, revokes live and fails closed", async () => {
  const original = globalThis.fetch;
  const identity: A4Identity = {
    user: {
      id: "10000000-0000-4000-8000-000000000001",
      email: "review@example.com",
      name: "Review",
    },
    organization: {
      id: "20000000-0000-4000-8000-000000000001",
      name: "Review company",
      role: "owner",
    },
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const config = {
    app: "brokk",
    authority: "https://app.a4.ia.br",
    origin: "https://brokk.a4.ia.br",
    secret: "fixture".repeat(8),
    prefix: "/api/auth/a4",
  };
  const app = new Hono();
  let active = true,
    unavailable = false,
    exchanges = 0,
    verifier = "";
  globalThis.fetch = async (input, init) => {
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${config.secret}`,
    );
    if (unavailable) throw new Error("offline");
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith("/exchange")) {
      exchanges++;
      verifier = body.verifier;
      return Response.json({ token: "T".repeat(43), ...identity });
    }
    return active
      ? Response.json(identity)
      : Response.json({}, { status: 401 });
  };
  app.use(
    "*",
    a4Session(config, {
      legacyCallbacks: ["/api/auth/callback"],
      logoutPaths: ["/api/auth/logout"],
    }),
  );
  app.get("/", (c) => c.text("workspace"));
  app.get("/api/data", (c) => c.json({ private: true }));
  app.post("/api/data", (c) => c.json({ saved: true }));
  const request = (path: string, init: RequestInit = {}) =>
    app.request(config.origin + path, init);
  try {
    assert.equal(
      (
        await request("/api/data", {
          headers: { cookie: "brokk_session=legacy; logto=legacy" },
        })
      ).status,
      401,
    );
    assert.equal((await request("/api/auth/callback?code=legacy")).status, 401);
    const start = await request("/api/auth/a4/start?return=//evil.example");
    const authorize = new URL(start.headers.get("location")!);
    const cookie = start.headers.get("set-cookie")!;
    assert.match(cookie, /__Host-a4_flow=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.doesNotMatch(cookie, /Domain=/i);
    const flow = cookie.split(";")[0];
    const state = authorize.searchParams.get("state")!;
    assert.equal(
      (
        await request(
          `/api/auth/a4/callback?code=${"C".repeat(43)}&state=${"X".repeat(43)}`,
          { headers: { cookie: flow } },
        )
      ).status,
      401,
    );
    assert.equal(exchanges, 0);
    const callback = await request(
      `/api/auth/a4/callback?code=${"C".repeat(43)}&state=${state}`,
      { headers: { cookie: flow } },
    );
    assert.equal(callback.headers.get("location"), "/");
    assert.equal(
      createHash("sha256").update(verifier).digest("base64url"),
      authorize.searchParams.get("challenge"),
    );
    const session = callback.headers
      .get("set-cookie")!
      .split(",")
      .find((v) => v.includes("__Host-a4_app="))!
      .trim()
      .split(";")[0];
    assert.equal(
      (await request("/api/data", { headers: { cookie: session } })).status,
      200,
    );
    identity.organization.role = "viewer";
    assert.equal(
      (
        await request("/api/data", {
          method: "POST",
          headers: { cookie: session, origin: config.origin },
        })
      ).status,
      403,
    );
    identity.organization.role = "owner";
    assert.equal(
      (
        await request("/api/data", {
          method: "POST",
          headers: { cookie: session, origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    active = false;
    assert.equal(
      (await request("/api/data", { headers: { cookie: session } })).status,
      401,
    );
    unavailable = true;
    assert.equal(
      (await request("/api/data", { headers: { cookie: session } })).status,
      503,
    );
    const logout = await request("/api/auth/logout", {
      method: "POST",
      headers: { origin: config.origin },
    });
    assert.equal(
      (await logout.json()).redirect,
      config.authority + "/assistentes",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Calls deep links bind the project company across fresh and different-company A4 sessions", async () => {
  const original = globalThis.fetch;
  const project = "30000000-0000-4000-8000-000000000001";
  const company = "20000000-0000-4000-8000-000000000001";
  const otherCompany = "20000000-0000-4000-8000-000000000002";
  const path = `/projects/${project}/calls?view=review`;
  const config = {
    app: "brokk",
    authority: "https://app.a4.ia.br",
    origin: "https://brokk.a4.ia.br",
    secret: "fixture".repeat(8),
    prefix: "/api/auth/a4",
  };
  let activeCompany = otherCompany,
    exchangedCompany = company;
  const identity = (org: string) => ({
    user: {
      id: "10000000-0000-4000-8000-000000000001",
      email: "operator@example.test",
      name: "Operator",
    },
    organization: { id: org, name: "Company", role: "owner" },
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  globalThis.fetch = async (input) =>
    Response.json(
      String(input).endsWith("/exchange")
        ? { ...identity(exchangedCompany), token: "T".repeat(43) }
        : identity(activeCompany),
    );
  const app = new Hono();
  app.use(
    "*",
    a4Session(config, {
      organization: async (p) =>
        p.startsWith(`/projects/${project}/`) ? company : null,
    }),
  );
  app.get(`/projects/${project}/calls`, (c) => c.text("Calls"));
  const request = (p: string, cookie = "") =>
    app.request(config.origin + p, { headers: { cookie } });
  try {
    for (const cookie of ["", `__Host-a4_app=${"S".repeat(43)}`]) {
      const redirected = await request(path, cookie);
      const login = new URL(redirected.headers.get("location")!, config.origin);
      assert.equal(login.pathname, "/api/auth/a4/start");
      assert.equal(login.searchParams.get("org"), company);
      assert.equal(login.searchParams.get("return"), path);
      // A conflicting caller hint must not override the stored project company.
      login.searchParams.set("org", otherCompany);
      const start = await request(login.pathname + login.search);
      const authorize = new URL(start.headers.get("location")!);
      assert.equal(authorize.searchParams.get("org"), company);
      const flow = start.headers.get("set-cookie")!.split(";")[0];
      const callbackPath = `/api/auth/a4/callback?code=${"C".repeat(43)}&state=${authorize.searchParams.get("state")}`;
      const callback = await request(callbackPath, flow);
      assert.equal(callback.headers.get("location"), path);
      assert.match(callback.headers.get("set-cookie")!, /__Host-a4_app=/);
      exchangedCompany = otherCompany;
      const wrong = await request(callbackPath, flow);
      assert.equal(wrong.status, 503);
      assert.doesNotMatch(wrong.headers.get("set-cookie")!, /__Host-a4_app=/);
      exchangedCompany = company;
    }
    activeCompany = company;
    const direct = await request(path, `__Host-a4_app=${"S".repeat(43)}`);
    assert.equal(direct.status, 200);
    assert.equal(await direct.text(), "Calls");
  } finally {
    globalThis.fetch = original;
  }
});
