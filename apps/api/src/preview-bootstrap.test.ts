import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Store } from "@brokk/db";
import { buildApp, type AppDeps } from "./app.js";

// Regressão da lane de preview (fleet-wide outage de 12–13/08/2026).
//
// O commit 1a66b69 ("require bearer on GETs") fechou as leituras abertas do
// control-plane — correto. O efeito colateral: o PreviewSupervisor do forge lia
// `GET /projects/:id` + `GET /repositories/:id` com o RUNNER secret, levou 401, e
// como o boot morre na primeira leitura, TODO preview da frota foi para `failed`.
// Nenhum subia.
//
// Estes testes prendem as duas metades da correção, e a segunda importa tanto
// quanto a primeira:
//
//   1. o runner CONSEGUE ler o que precisa para bootar (via /previews/:id/bootstrap);
//   2. o runner NÃO reconquistou acesso a /projects e /repositories.
//
// Sem (2), a "correção" mais fácil (isentar os prefixos do guard) passaria neste
// arquivo enquanto reabria exatamente o que o hardening fechou.

const RUNNER = "runner-secret-de-teste";
const API = "api-secret-de-teste";

const PREVIEW = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  branch: "dev",
  subdomain: "app",
  hauldrProject: "app_dev",
  status: "starting",
};
const PROJECT = {
  id: PREVIEW.projectId,
  repositoryId: "33333333-3333-4333-8333-333333333333",
  name: "app",
  baseBranch: "dev",
  logtoOrgId: null,
};
const REPOSITORY = {
  id: PROJECT.repositoryId,
  fullName: "cold-code-labs/app",
  owner: "cold-code-labs",
  name: "app",
  defaultBranch: "main",
  cloneUrl: "https://github.com/cold-code-labs/app.git",
  installationId: "999",
};

function deps(): AppDeps {
  const store = {
    getPreview: async (id: string) => (id === PREVIEW.id ? PREVIEW : null),
    getProject: async (id: string) => (id === PROJECT.id ? PROJECT : null),
    getRepository: async (id: string) => (id === REPOSITORY.id ? REPOSITORY : null),
  } as unknown as Store;
  return {
    store,
    runnerSecret: RUNNER,
    apiSecret: API,
    githubWebhookSecret: "",
  } as AppDeps;
}

function get(app: ReturnType<typeof buildApp>, path: string, token?: string) {
  return app.request(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("preview bootstrap — o forge boota com o runner secret", () => {
  it("devolve project + repository para o runner secret", async () => {
    const app = buildApp(deps());
    const res = await get(app, `/previews/${PREVIEW.id}/bootstrap`, RUNNER);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { project: { id: string }; repository: { id: string } };
    assert.equal(body.project.id, PROJECT.id);
    assert.equal(body.repository.id, REPOSITORY.id);
    // O supervisor usa cloneUrl/installationId para o checkout — se sumirem, o
    // boot quebra longe daqui, no git.
    assert.equal(
      (body.repository as unknown as { cloneUrl: string }).cloneUrl,
      REPOSITORY.cloneUrl,
    );
  });

  it("aceita também o api secret (o botão 'Subir preview' na UI)", async () => {
    const app = buildApp(deps());
    const res = await get(app, `/previews/${PREVIEW.id}/bootstrap`, API);
    assert.equal(res.status, 200);
  });

  it("sem bearer é 401 — a rota não é pública", async () => {
    const app = buildApp(deps());
    const res = await get(app, `/previews/${PREVIEW.id}/bootstrap`);
    assert.equal(res.status, 401);
  });

  it("preview inexistente é 404, não vaza projeto", async () => {
    const app = buildApp(deps());
    const res = await get(app, "/previews/44444444-4444-4444-8444-444444444444/bootstrap", RUNNER);
    assert.equal(res.status, 404);
  });
});

describe("o hardening de 1a66b69 continua de pé", () => {
  it("runner NÃO lê /projects/:id", async () => {
    const app = buildApp(deps());
    const res = await get(app, `/projects/${PROJECT.id}`, RUNNER);
    assert.equal(res.status, 401);
  });

  it("runner NÃO lê /repositories/:id", async () => {
    const app = buildApp(deps());
    const res = await get(app, `/repositories/${REPOSITORY.id}`, RUNNER);
    assert.equal(res.status, 401);
  });

  it("leitura anônima do control-plane continua fechada", async () => {
    const app = buildApp(deps());
    assert.equal((await get(app, `/projects/${PROJECT.id}`)).status, 401);
    assert.equal((await get(app, "/previews")).status, 401);
  });

  it("as sondas públicas seguem públicas", async () => {
    const app = buildApp(deps());
    assert.equal((await get(app, "/health")).status, 200);
  });
});
