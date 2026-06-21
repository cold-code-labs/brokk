import type { Store } from "@brokk/db";
import type { MimirConfig } from "@brokk/mimir";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { version } from "../package.json";
import { mimirRoutes } from "./routes/mimir.js";
import { projectsRoutes } from "./routes/projects.js";
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
  /** Mímir model config (triador + enhancer). Undefined = enhance/triage → 503. */
  mimir?: MimirConfig;
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
  app.get("/version", (c) => c.json({ version }));

  app.route("/projects", projectsRoutes(deps));
  app.route("/mimir", mimirRoutes(deps));
  app.route("/users", usersRoutes(deps));
  app.route("/subscriptions", subscriptionsRoutes(deps));
  app.route("/tasks", tasksRoutes(deps));
  app.route("/runs", runsRoutes(deps));
  app.route("/runner", runnerRoutes(deps));
  app.route("/webhooks", webhooksRoutes(deps));

  return app;
}
