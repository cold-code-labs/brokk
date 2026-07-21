import { serve } from "@hono/node-server";
import { createDb, createStore, ensureSchema } from "@brokk/db";
import { loadMimirConfig } from "@brokk/mimir";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startMissionReconciler } from "./missions.js";
import { startReviewReconciler } from "./review-reconciler.js";

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
    heimdallAgentUrl: cfg.HEIMDALL_AGENT_URL,
    heimdallAgentToken: cfg.HEIMDALL_AGENT_TOKEN,
    heimdallUrl: cfg.HEIMDALL_AGENT_URL,
    heimdallToken: cfg.HEIMDALL_AGENT_TOKEN,
  });

  // Regin (ADR 0027 §5.4): the mission reconciler rides the API process — one
  // singleton tick loop; without Mímir, missions block at planning (never crash).
  startMissionReconciler({ store, mimir });

  // BROKK-45: heal Review→Done when the GitHub merge webhook is missed, and when
  // the forge opened a successor PR (#5 closed unmerged → #6 merged).
  startReviewReconciler({ store, githubToken: cfg.GITHUB_TOKEN });

  serve({ fetch: app.fetch, port: cfg.BROKK_API_PORT }, ({ port }) => {
    console.log(`brokk control-plane listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
