import type { Store } from "@brokk/db";
import type { MimirConfig } from "@brokk/mimir";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { version } from "../package.json";
import { chatRoutes } from "./routes/chat.js";
import { mimirRoutes } from "./routes/mimir.js";
import { previewsRoutes } from "./routes/previews.js";
import { projectsRoutes } from "./routes/projects.js";
import { repositoriesRoutes } from "./routes/repositories.js";
import { runnerRoutes } from "./routes/runner.js";
import { runsRoutes } from "./routes/runs.js";
import { subscriptionsRoutes } from "./routes/subscriptions.js";
import { tasksRoutes } from "./routes/tasks.js";
import { usersRoutes } from "./routes/users.js";
import { webhooksRoutes } from "./routes/webhooks.js";

export interface AppDeps {
  store: Store;
  /** Shared secret guarding the runner endpoints. Empty = runner endpoints 503. */
  runnerSecret: string;
  /** Bearer secret guarding mutating API calls (POST/PUT/PATCH/DELETE). The web
   *  proxy injects it server-side. Empty = open (local/dev). */
  apiSecret: string;
  /** GitHub webhook HMAC secret. Empty = skip signature check (local dev). */
  githubWebhookSecret: string;
  /** Mímir model config (triador + enhancer). Undefined = enhance/triage → 503. */
  mimir?: MimirConfig;
  /** Base URL of the Sindri chat runtime (e.g. http://127.0.0.1:8795). Empty =
   *  /chat returns 503. */
  sindriUrl?: string;
}

/** Assemble the control-plane HTTP app from its dependencies. Pure wiring — no
 *  I/O at construction — so it can be exercised with a fake store. */
export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use("*", cors());

  // Errors as JSON problem objects.
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, service: "brokk-api" }));
  app.get("/ping", (c) => c.json({ pong: true }));
  app.get("/version", (c) => c.json({ version }));

  // Guard mutating calls behind the API secret. The browser reaches the API only
  // through the web's server-side proxy, which injects the bearer; a direct caller
  // (e.g. a leaked origin port) can't create/enqueue tasks. /runner self-auths with
  // its own secret, /webhooks with the GitHub HMAC, and reads stay open.
  app.use("*", async (c, next) => {
    if (!deps.apiSecret) return next();
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    const path = c.req.path;
    // /runner, /webhooks and /previews self-authenticate (runner secret / GitHub
    // HMAC), so they're exempt from the api-secret guard. /previews carries the
    // preview lifecycle that the gateway (wake POST) and runner (status PATCH)
    // drive with the runner secret — guarding it here 401s those internal writes
    // and freezes the whole preview lane.
    if (
      path.startsWith("/runner") ||
      path.startsWith("/webhooks") ||
      path.startsWith("/previews")
    )
      return next();
    if (c.req.header("authorization") === `Bearer ${deps.apiSecret}`) return next();
    return c.json({ error: "unauthorized" }, 401);
  });

  app.route("/repositories", repositoriesRoutes(deps));
  app.route("/projects", projectsRoutes(deps));
  app.route("/previews", previewsRoutes(deps));
  app.route("/mimir", mimirRoutes(deps));
  app.route("/chat", chatRoutes(deps));
  app.route("/users", usersRoutes(deps));
  app.route("/subscriptions", subscriptionsRoutes(deps));
  app.route("/tasks", tasksRoutes(deps));
  app.route("/runs", runsRoutes(deps));
  app.route("/runner", runnerRoutes(deps));
  app.route("/webhooks", webhooksRoutes(deps));

  return app;
}
