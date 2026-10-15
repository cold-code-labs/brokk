import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { buildApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./store.ts";

const cfg = readConfig(),
  store = createStore(cfg.databaseUrl);
await store.migrate();
const app = buildApp(store, cfg);
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
