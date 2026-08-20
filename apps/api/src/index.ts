import { serve } from "@hono/node-server";
import { CoderClient } from "@brokk/coder";
import { createDb, createStore, ensureSchema } from "@brokk/db";
import { buildApp } from "./app.js";
import { BancadaService } from "./bancada.js";
import { startBancadaReaper } from "./bancada-reaper.js";
import { loadConfig } from "./config.js";
import { loadAppAuth, getInstallationToken } from "./github.js";
import { makeHauldrDataProvider, passthroughProvider } from "./lanes/data-provider.js";
import { HeimdallLanes } from "./lanes/heimdall-lanes.js";
import { startMissionReconciler } from "./missions.js";
import { startReviewReconciler } from "./review-reconciler.js";

async function main() {
  const cfg = loadConfig();

  const { db } = createDb(cfg.BROKK_DATABASE_URL);
  await ensureSchema(db);
  const store = createStore(db);

  console.log("[mimir] Brokk cortex terminated — use Chat Plan → Forge");

  // ── the runtime (ADR 0100) ────────────────────────────────────────────────
  // The dev lane a bancada boots against is asked for through Heimdall, never
  // provisioned here: reaching the data plane directly would need Hauldr's
  // MANAGEMENT key, which reads every project on the fleet.
  const lanes =
    cfg.HEIMDALL_AGENT_URL && cfg.HEIMDALL_AGENT_TOKEN
      ? new HeimdallLanes(cfg.HEIMDALL_AGENT_URL, cfg.HEIMDALL_AGENT_TOKEN)
      : null;
  const dataProvider =
    lanes && cfg.HAULDR_CONTROL_URL
      ? makeHauldrDataProvider(lanes, cfg.HAULDR_CONTROL_URL)
      : passthroughProvider;

  const appAuth = loadAppAuth();
  const bancadas =
    cfg.CODER_URL && cfg.CODER_TOKEN
      ? new BancadaService({
          store,
          coder: new CoderClient({ url: cfg.CODER_URL, token: cfg.CODER_TOKEN }),
          data: dataProvider,
          template: cfg.CODER_TEMPLATE,
          controlUrl: cfg.BROKK_INTERNAL_URL,
          mintGitToken: appAuth
            ? async (fullName: string) => {
                const repo = await store.getRepositoryByFullName(fullName);
                if (!repo?.installationId) return null;
                return getInstallationToken(appAuth, repo.installationId);
              }
            : undefined,
        })
      : undefined;
  console.log(
    bancadas
      ? `[bancada] runtime: ${cfg.CODER_URL} (template ${cfg.CODER_TEMPLATE}, lane env: ${dataProvider.name})`
      : "[bancada] runtime OFF — CODER_URL/CODER_TOKEN não configurados",
  );

  const app = buildApp({
    store,
    bancadas,
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
    svalinnApiUrl: cfg.SVALINN_API_URL,
    svalinnMachineToken: cfg.SVALINN_MACHINE_TOKEN,
  });

  // Regin still ticks for in-flight missions; new planning is blocked (no Mímir).
  startMissionReconciler({ store });

  startReviewReconciler({ store, githubToken: cfg.GITHUB_TOKEN });

  if (bancadas) startBancadaReaper({ store, bancadas, idleMs: cfg.BANCADA_IDLE_MS });

  serve({ fetch: app.fetch, port: cfg.BROKK_API_PORT }, ({ port }) => {
    console.log(`brokk control-plane listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
