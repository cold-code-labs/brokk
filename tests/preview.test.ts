import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../server/config.ts";
import { createPreviewProvider, environmentRecipe } from "../server/preview.ts";
import type { EnvironmentRecord } from "../shared/environment.ts";

const cfg = readConfig({
  NODE_ENV: "test",
  BROKK_DATABASE_URL: "postgres://unused/db_test",
  BROKK_REPOSITORY_OWNER: "cold-code-labs",
  BROKK_PREVIEW_DOMAIN: "preview.example.test",
  BROKK_PREVIEW_ALIAS_DOMAIN: "example.test",
  BROKK_COOLIFY_URL: "https://engine.test/api",
  BROKK_HAULDR_URL: "https://backend.test",
  BROKK_WOODPECKER_URL: "https://ci.test/api",
});
const env: EnvironmentRecord = {
  ...environmentRecipe(
    cfg,
    "12345678-1234-1234-1234-123456789012",
    "cold-code-labs/nfcs",
    {
      slug: "nfcs",
      hostname: "nfcs-preview.example.test",
      productionUrl: "https://nfcs.example.test",
      profile: "static",
    },
  ),
  projectId: "12345678-1234-1234-1234-123456789012",
  branch: "preview",
  state: "waiting",
  step: "prepared",
  detail: "",
  dataReady: true,
  ciState: "pending",
  commit: "",
  deployedCommit: "",
  version: 1,
  updatedAt: "",
  lease: "private-lease",
  resources: {
    application: "app-ref",
    dataProject: "nfcs_dev",
    deployment: "deploy-ref",
  },
};

test("preparation reuses an active Woodpecker repository instead of activating it again", async () => {
  const original = globalThis.fetch;
  let activation = 0;
  globalThis.fetch = async (input, _options) => {
    const url = String(input);
    let body: unknown = {};
    if (url.endsWith(`/repos/${env.repository}`))
      body = {
        full_name: env.repository,
        id: 1371850586,
        default_branch: "main",
        archived: false,
      };
    else if (url.includes("/repos/lookup/")) body = { active: true };
    else if (url.includes("/repos?forge_remote_id=")) {
      activation++;
      return new Response("Already activated", { status: 409 });
    } else if (url.includes("/git/ref/heads/preview"))
      body = { object: { sha: "a".repeat(40) } };
    else if (url.includes("/v1/projects/")) body = { status: "live" };
    else if (url.endsWith("/applications"))
      body = [{ name: "nfcs-preview", uuid: "app-ref" }];
    else if (url.endsWith("/applications/app-ref"))
      body = {
        name: "nfcs-preview",
        uuid: "app-ref",
        description: `Brokk project ${env.projectId} preview`,
        git_repository: env.repository,
        git_branch: "preview",
      };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    let current = structuredClone(env);
    const result = await createPreviewProvider(cfg).prepare(
      current,
      async (patch) => {
        current = { ...current, ...patch };
        return current;
      },
    );
    assert.equal(result.step, "prepared");
    assert.equal(result.dataReady, true);
    assert.equal(activation, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test("recipes cannot redirect credentials or take over protected fleet names", () => {
  assert.equal(env.previewUrl, "https://nfcs-preview.example.test");
  assert.throws(() =>
    environmentRecipe(cfg, env.projectId, null, { slug: "brokk" }),
  );
  assert.throws(() =>
    environmentRecipe(cfg, env.projectId, null, {
      slug: "nfcs",
      hostname: "attacker.example",
    }),
  );
  assert.throws(() =>
    environmentRecipe(cfg, env.projectId, "another-owner/nfcs", {
      slug: "nfcs",
    }),
  );
  assert.throws(() =>
    environmentRecipe(cfg, env.projectId, null, {
      slug: "nfcs",
      productionUrl: "https://user:password@nfcs.example.test",
    }),
  );
});
test("red CI and changed heads block release; readiness requires the deployed commit", async () => {
  const original = globalThis.fetch;
  let mutations = 0;
  let pipelineStatus = "failure";
  const current = "a".repeat(40);
  globalThis.fetch = async (input, options) => {
    if (options?.method && options.method !== "GET") mutations++;
    const url = String(input);
    let body: unknown = {};
    if (url.endsWith("/applications"))
      body = [{ name: "nfcs-preview", uuid: "app-ref" }];
    else if (url.endsWith("/applications/app-ref"))
      body = {
        name: "nfcs-preview",
        uuid: "app-ref",
        description: `Brokk project ${env.projectId} preview`,
        git_repository: env.repository,
        git_branch: "preview",
      };
    else if (url.includes("/git/ref/heads/preview"))
      body = { object: { sha: current } };
    else if (url.includes("/repos/lookup/")) body = { id: 37, active: true };
    else if (url.includes("/pipelines?"))
      body = [
        { number: 1, event: "push", commit: current, status: "success" },
        { number: 2, event: "push", commit: current, status: pipelineStatus },
        { number: 3, event: "push", commit: "b".repeat(40), status: "success" },
      ];
    else if (url.includes("/v1/projects/")) body = { status: "live" };
    else if (url.includes("/deployments/deploy-ref"))
      body = { status: "finished", commit: "b".repeat(40) };
    else if (url.includes("/pulls/1"))
      body = {
        base: { ref: "preview" },
        head: { sha: current, repo: { full_name: env.repository } },
        draft: false,
        state: "open",
      };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const p = createPreviewProvider(cfg);
    await assert.rejects(() => p.deploy(env), /Woodpecker/);
    await assert.rejects(() => p.merge(env, 1, "b".repeat(40)), /mudou/);
    await assert.rejects(() => p.merge(env, 1, current), /Woodpecker/);
    const status = await p.inspect(env);
    assert.notEqual(status.state, "ready");
    assert.equal(status.commit, current);
    assert.equal(status.ciState, "failure");
    pipelineStatus = "running";
    assert.equal((await p.inspect(env)).ciState, "pending");
    pipelineStatus = "success";
    assert.equal((await p.inspect(env)).ciState, "success");
    assert.equal(mutations, 0);
  } finally {
    globalThis.fetch = original;
  }
});
