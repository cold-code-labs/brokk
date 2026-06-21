import { serve } from "@hono/node-server";
import { createDb, createStore, ensureSchema } from "@brokk/db";
import { loadMimirConfig } from "@brokk/mimir";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main() {
  const cfg = loadConfig();

  const { db } = createDb(cfg.BROKK_DATABASE_URL);
  await ensureSchema(db);
  const store = createStore(db);

  // Mímir is optional at boot: without MIMIR_API_KEY the bank still works,
  // only enhance/triage return 503.
  let mimir;
  try {
    mimir = loadMimirConfig();
  } catch {
    mimir = undefined;
    console.warn("[mimir] MIMIR_API_KEY not set — enhance/triage disabled");
  }

  const app = buildApp({
    store,
    runnerSecret: cfg.BROKK_RUNNER_SECRET,
    githubWebhookSecret: cfg.BROKK_GITHUB_WEBHOOK_SECRET,
    mimir,
  });

  serve({ fetch: app.fetch, port: cfg.BROKK_API_PORT }, ({ port }) => {
    console.log(`brokk control-plane listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
