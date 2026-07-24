import { serve } from "@hono/node-server";
import { createDb, createStore, ensureSchema } from "@brokk/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startMissionReconciler } from "./missions.js";
import { startReviewReconciler } from "./review-reconciler.js";

async function main() {
  const cfg = loadConfig();

  const { db } = createDb(cfg.BROKK_DATABASE_URL);
  await ensureSchema(db);
  const store = createStore(db);

  console.log("[mimir] Brokk cortex terminated — use Chat Plan → Forge");

  const app = buildApp({
    store,
    runnerSecret: cfg.BROKK_RUNNER_SECRET,
    apiSecret: cfg.BROKK_API_SECRET,
    githubWebhookSecret: cfg.BROKK_GITHUB_WEBHOOK_SECRET,
    githubToken: cfg.GITHUB_TOKEN,
    eitriUrl: cfg.EITRI_URL || "http://reviewer:8796",
    sindriUrl: cfg.BROKK_SINDRI_URL,
    heimdallAgentUrl: cfg.HEIMDALL_AGENT_URL,
    heimdallAgentToken: cfg.HEIMDALL_AGENT_TOKEN,
    heimdallUrl: cfg.HEIMDALL_AGENT_URL,
    heimdallToken: cfg.HEIMDALL_AGENT_TOKEN,
  });

  // Regin still ticks for in-flight missions; new planning is blocked (no Mímir).
  startMissionReconciler({ store });

  startReviewReconciler({ store, githubToken: cfg.GITHUB_TOKEN });

  serve({ fetch: app.fetch, port: cfg.BROKK_API_PORT }, ({ port }) => {
    console.log(`brokk control-plane listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
