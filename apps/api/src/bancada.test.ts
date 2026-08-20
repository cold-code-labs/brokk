import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { CoderClient, CoderWorkspace } from "@brokk/coder";
import type { Store } from "@brokk/db";
import { BancadaRefused, BancadaService } from "./bancada.js";
import { passthroughProvider } from "./lanes/data-provider.js";

const runtime = {
  id: "vite",
  label: "Vite",
  appRoot: ".",
  install: "pnpm install",
  dev: "pnpm exec vite --port $PORT --host 0.0.0.0",
  supported: true,
  source: "preset" as const,
};

function fakeStore(over: Partial<Record<keyof Store, unknown>> = {}) {
  const row = {
    id: "b-1",
    projectId: "p-1",
    lane: "dev",
    branch: "dev",
    workspaceId: null as string | null,
    workspaceName: "arte-dev",
    ownerName: null,
    hauldrProject: null,
    status: "provisioning",
    detail: null,
    previewUrl: null,
    agentUrl: null,
    runtimeId: "vite",
    commitSha: null,
    tokenHash: null as string | null,
    lastActivityAt: "now",
    createdAt: "now",
    updatedAt: "now",
  };
  const patches: Array<Record<string, unknown>> = [];
  return {
    row,
    patches,
    store: {
      getProject: async () => ({
        id: "p-1",
        name: "arte",
        repositoryId: "r-1",
        baseBranch: "dev",
        runtime,
        logtoOrgId: null,
      }),
      getRepository: async () => ({ id: "r-1", name: "arte", fullName: "ccl/arte" }),
      ensureBancada: async () => ({ bancada: { ...row }, created: true }),
      patchBancada: async (_id: string, patch: Record<string, unknown>) => {
        patches.push(patch);
        Object.assign(row, patch);
        return { ...row };
      },
      touchBancada: async () => ({ ...row }),
      getBancadaByTokenHash: async (hash: string) =>
        hash === row.tokenHash ? { ...row } : null,
      ...over,
    } as unknown as Store,
  };
}

const liveWorkspace: CoderWorkspace = {
  id: "ws-1",
  name: "arte-dev",
  owner_id: "u",
  owner_name: "brokk",
  organization_id: "o",
  template_id: "t",
  template_name: "bancada",
  latest_build: {
    id: "b",
    build_number: 1,
    transition: "start",
    status: "running",
    job: { id: "j", status: "succeeded" },
    resources: [
      {
        id: "r",
        type: "docker_container",
        name: "workspace",
        agents: [{ id: "a", name: "main", status: "connected", lifecycle_state: "ready", apps: [] }],
      },
    ],
  },
};

function fakeCoder(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const coder = {
    workspaceByName: async () => null,
    workspace: async () => liveWorkspace,
    templateByName: async () => ({ id: "t-1", name: "bancada", active_version_id: "v-1" }),
    createWorkspace: async () => {
      calls.push("create");
      return liveWorkspace;
    },
    build: async (_id: string, transition: string) => {
      calls.push(`build:${transition}`);
      return { id: "b", status: "pending" };
    },
    waitForBuild: async () => {
      calls.push("wait");
      return liveWorkspace;
    },
    appUrl: () => "https://coder.test/@brokk/arte-dev.main/apps/bancada/",
    ...over,
  } as unknown as CoderClient;
  return { coder, calls };
}

function service(store: Store, coder: CoderClient, mint?: (r: string) => Promise<string | null>) {
  return new BancadaService({
    store,
    coder,
    data: passthroughProvider,
    template: "bancada",
    controlUrl: "http://brokk-api:8789",
    mintGitToken: mint,
  });
}

describe("BancadaService.ensure", () => {
  it("adopts a workspace that is already running instead of forking a second one", async () => {
    const { store } = fakeStore();
    const { coder, calls } = fakeCoder({ workspaceByName: async () => liveWorkspace });
    await service(store, coder).ensure("p-1");
    assert.deepEqual(calls, [], "must not create or rebuild over a live workspace");
  });

  it("rebuilds a live workspace only when the caller asks for it", async () => {
    const { store } = fakeStore();
    const { coder, calls } = fakeCoder({ workspaceByName: async () => liveWorkspace });
    await service(store, coder).ensure("p-1", { restart: true });
    // O `wait` no meio não é zelo: o Coder recusa com 409 uma build enquanto a
    // anterior está em voo, e a bancada morria com um 500 sem explicação.
    assert.deepEqual(calls, ["build:stop", "wait", "build:start"]);
  });

  it("provisions when Coder has nothing", async () => {
    const { store } = fakeStore();
    const { coder, calls } = fakeCoder();
    await service(store, coder).ensure("p-1");
    assert.deepEqual(calls, ["create"]);
  });

  it("refuses a project with no runtime, with a reason a human can read", async () => {
    const { store } = fakeStore({
      getProject: async () => ({
        id: "p-1",
        name: "asgard",
        repositoryId: "r-1",
        baseBranch: "main",
        runtime: null,
        logtoOrgId: null,
      }),
    });
    const { coder } = fakeCoder();
    await assert.rejects(
      () => service(store, coder).ensure("p-1"),
      (err: unknown) => err instanceof BancadaRefused && err.status === 422,
    );
  });

  it("stores only the HASH of the bancada secret, never the secret", async () => {
    const { store, patches } = fakeStore();
    const { coder } = fakeCoder();
    await service(store, coder).ensure("p-1");
    const withHash = patches.find((p) => "tokenHash" in p)!;
    assert.match(String(withHash.tokenHash), /^[0-9a-f]{64}$/);
    // The secret is 32 random bytes in base64url = exactly 43 chars. Nothing we
    // persist may look like that (the hash is 64 hex chars, which does not).
    const persisted = patches.flatMap((p) => Object.values(p)).filter((v) => typeof v === "string");
    assert.ok(
      !persisted.some((v) => (v as string).length === 43),
      `a plaintext 32-byte secret must not be persisted: ${JSON.stringify(persisted)}`,
    );
  });
});

describe("BancadaService.gitCredential", () => {
  it("hands a short-lived token to a workspace that proves its secret", async () => {
    const secret = "s".repeat(43);
    const { store, row } = fakeStore();
    (row as Record<string, unknown>).tokenHash = createHash("sha256").update(secret).digest("hex");
    const { coder } = fakeCoder();
    const cred = await service(store, coder, async () => "ghs_fresh").gitCredential(secret);
    assert.deepEqual(cred, {
      username: "x-access-token",
      password: "ghs_fresh",
      repo: "ccl/arte",
    });
  });

  it("refuses an unknown secret without saying why", async () => {
    const { store } = fakeStore();
    const { coder } = fakeCoder();
    await assert.rejects(
      () => service(store, coder, async () => "ghs").gitCredential("n".repeat(43)),
      (err: unknown) => err instanceof BancadaRefused && err.status === 404,
    );
  });
});
