import { serve } from "@hono/node-server";
import { loadAflConfig } from "@brokk/chat";
import { createDb, createStore, ensureChatSchema } from "@brokk/db";
import { buildSindri } from "./app.js";
import { CheckoutManager } from "./checkout.js";
import { loadConfig } from "./config.js";
import { TurnManager } from "./turns.js";

async function main() {
  const cfg = loadConfig();

  // gh reads GH_TOKEN first, then GITHUB_TOKEN — mirror so `gh` works in bash.
  if (!process.env.GH_TOKEN && process.env.GITHUB_TOKEN) process.env.GH_TOKEN = process.env.GITHUB_TOKEN;

  const { db } = createDb(cfg.BROKK_DATABASE_URL);
  // Self-heal the chat tables (idempotent) — never depends on drizzle-kit push.
  await ensureChatSchema(db);
  const store = createStore(db);

  // The live turn registry is in-memory: any session still flagged `running` at
  // boot is an orphan from a crash/restart (its turn died with the old process).
  // Clear them so the UI doesn't show a phantom "running" and a new turn can start.
  const orphans = await store.resetRunningChatTurns().catch(() => 0);
  if (orphans) console.log(`[sindri] reset ${orphans} orphaned running turn(s) on boot`);

  const chatCfg = loadAflConfig();
  if (!chatCfg.authToken) {
    console.warn("[sindri] ANTHROPIC_AUTH_TOKEN unset — model calls to the gateway will fail");
  }
  console.log(`[sindri] gateway=${chatCfg.gatewayUrl} models=${chatCfg.models.sonnet}/${chatCfg.models.opus}`);
  console.log(`[sindri] workdir=${cfg.workDir}`);

  const app = buildSindri({
    store,
    cfg: chatCfg,
    checkouts: new CheckoutManager(cfg.workDir),
    turns: new TurnManager(),
    runnerSecret: cfg.BROKK_RUNNER_SECRET,
  });

  serve({ fetch: app.fetch, port: cfg.SINDRI_PORT }, ({ port }) => {
    console.log(`sindri listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
