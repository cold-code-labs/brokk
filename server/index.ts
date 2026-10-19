import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { a4Session } from "./a4-suite.ts";
import { buildApp } from "./app.ts";
import type { Env } from "./auth.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./store.ts";

const cfg = readConfig(),
  store = createStore(cfg.databaseUrl);
await store.migrate();
const app = new Hono<Env>();
app.use("*", async (c, next) => {
  if (
    cfg.suite.authority &&
    c.req.method === "GET" &&
    new URL(c.req.url).host !== new URL(cfg.origin).host &&
    !c.req.path.startsWith("/api/worker/") &&
    !c.req.path.startsWith("/api/extension/") &&
    c.req.path !== "/api/health"
  )
    return c.redirect(
      cfg.origin + new URL(c.req.url).pathname + new URL(c.req.url).search,
      307,
    );
  return next();
});
app.use(
  "*",
  a4Session(cfg.suite, {
    bypass: (c) =>
      [
        "/api/health",
        "/api/integrations/a4-coach",
        "/extension/privacy.html",
        "/extension/support.html",
        "/downloads/brokk-review.zip",
      ].includes(c.req.path) ||
      c.req.path.startsWith("/api/worker/cursor/") ||
      c.req.path.startsWith("/api/extension/"),
    loginPaths: ["/api/auth/start"],
    logoutPaths: ["/api/auth/logout"],
    legacyCallbacks: [
      "/api/auth/callback",
      "/api/auth/handoff",
      "/api/auth/dev",
      "/api/integrations/var/handoff",
    ],
  }),
);
app.route("/", buildApp(store, cfg));
app.use("*", async (c, next) => {
  if (
    cfg.production &&
    c.req.method === "GET" &&
    new URL(c.req.url).host !== new URL(cfg.origin).host &&
    !c.req.path.startsWith("/api/")
  )
    return c.redirect(
      `${cfg.origin}${new URL(c.req.url).pathname}${new URL(c.req.url).search}`,
      307,
    );
  await next();
});
app.get("/downloads/brokk-review.zip", (c) =>
  c.redirect("https://app.a4.ia.br/downloads/a4-live-coach.zip?v=2.0.0", 302),
);
app.use("/downloads/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.use("*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));
const server = serve(
  { fetch: app.fetch, port: cfg.port, hostname: cfg.host },
  () => console.log(`Brokk: http://${cfg.host}:${cfg.port}`),
);
async function stop() {
  server.close();
  await store.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
