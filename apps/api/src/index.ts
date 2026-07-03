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

  // Mímir is optional at boot: without a usable provider (Max seat or OpenAI
  // key) the bank still works, only enhance/triage/plan return 503.
  const mimir = loadMimirConfig();
  if (!mimir) {
    console.warn("[mimir] no provider (CLAUDE_CODE_OAUTH_TOKEN / MIMIR_API_KEY) — enhance/triage/plan disabled");
  } else {
    console.log(`[mimir] provider=${mimir.provider} planner=${mimir.plannerModel}`);
  }

  const app = buildApp({
    store,
    runnerSecret: cfg.BROKK_RUNNER_SECRET,
    apiSecret: cfg.BROKK_API_SECRET,
    githubWebhookSecret: cfg.BROKK_GITHUB_WEBHOOK_SECRET,
    mimir,
    sindriUrl: cfg.BROKK_SINDRI_URL,
    hauldrControlUrl: cfg.HAULDR_CONTROL_URL,
    hauldrToken: cfg.HAULDR_TOKEN,
  });

  serve({ fetch: app.fetch, port: cfg.BROKK_API_PORT }, ({ port }) => {
    console.log(`brokk control-plane listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
