import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CoderClient, CoderError } from "./client.js";
import { UnrunnableProject, bancadaParameters, workspaceName } from "./bancada.js";
import type { CoderWorkspace } from "./types.js";
import type { RuntimeSpec } from "@brokk/core";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Record every call and answer from a scripted table keyed by `METHOD path`. */
function fakeFetch(table: Record<string, { status?: number; body?: unknown }>) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const u = new URL(String(url));
    calls.push({
      method,
      url: u.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const hit = table[`${method} ${u.pathname}`];
    const status = hit?.status ?? (hit ? 200 : 404);
    return new Response(hit?.body === undefined ? "" : JSON.stringify(hit.body), { status });
  }) as typeof fetch;
  return calls;
}

const ws = (over: Partial<CoderWorkspace> = {}): CoderWorkspace => ({
  id: "ws-1",
  name: "arte-dev",
  owner_id: "u-1",
  owner_name: "brokk",
  organization_id: "org-1",
  template_id: "t-1",
  template_name: "bancada",
  latest_build: {
    id: "b-1",
    build_number: 1,
    transition: "start",
    status: "running",
    job: { id: "j-1", status: "succeeded" },
    resources: [
      {
        id: "r-1",
        type: "docker_container",
        name: "workspace",
        agents: [
          {
            id: "a-1",
            name: "main",
            status: "connected",
            lifecycle_state: "ready",
            apps: [
              {
                id: "app-1",
                slug: "bancada",
                subdomain: false,
                sharing_level: "authenticated",
                health: "healthy",
              },
            ],
          },
        ],
      },
    ],
  },
  ...over,
});

const client = () => new CoderClient({ url: "https://coder.test/", token: "tok" });

describe("CoderClient", () => {
  it("carries the session token and never leaks it into the URL", async () => {
    let seenHeader: string | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      seenHeader = new Headers(init?.headers).get("Coder-Session-Token") ?? undefined;
      return new Response(JSON.stringify({ id: "u", username: "brokk", email: "b@c", status: "active" }));
    }) as typeof fetch;
    const me = await client().me();
    assert.equal(me.username, "brokk");
    assert.equal(seenHeader, "tok");
  });

  it("turns a missing workspace into null, not an exception", async () => {
    fakeFetch({});
    assert.equal(await client().workspaceByName("nope"), null);
  });

  it("surfaces non-404 failures as CoderError with the status", async () => {
    fakeFetch({ "GET /api/v2/workspaces/ws-1": { status: 500, body: { message: "boom" } } });
    await assert.rejects(
      () => client().workspace("ws-1"),
      (err: unknown) => err instanceof CoderError && err.status === 500,
    );
  });

  it("addresses apps by PATH — no wildcard host, no third-level cert", () => {
    assert.equal(
      client().appUrl(ws(), "bancada"),
      "https://coder.test/@brokk/arte-dev.main/apps/bancada/",
    );
  });

  it("reaches the in-workspace agent through the app proxy", async () => {
    const calls = fakeFetch({
      "POST /@brokk/arte-dev.main/apps/ccw/message": { body: { ok: true } },
    });
    assert.deepEqual(await client().agentSend(ws(), "olá"), { ok: true });
    assert.deepEqual(calls[0]?.body, { content: "olá", type: "user" });
  });

  it("devolve o MOTIVO de uma recusa, não só um falso", async () => {
    // Um envio recusado separa "o agente está pensando" de "o agente está parado
    // numa tela esperando Enter" — e as duas exigem ações opostas.
    fakeFetch({
      "POST /@brokk/arte-dev.main/apps/ccw/message": {
        status: 500,
        body: { errors: [{ message: "failed to wait for screen to stabilize" }] },
      },
    });
    const out = await client().agentSend(ws(), "olá");
    assert.equal(out.ok, false);
    assert.match(out.reason ?? "", /stabilize/);
  });

  it("reports `unknown` when the agent app does not answer", async () => {
    fakeFetch({});
    assert.equal(await client().agentStatus(ws()), "unknown");
  });

  it("stops polling once the build settles", async () => {
    const calls = fakeFetch({ "GET /api/v2/workspaces/ws-1": { body: ws() } });
    const out = await client().waitForBuild("ws-1", { intervalMs: 1 });
    assert.equal(out.latest_build.status, "running");
    assert.equal(calls.length, 1);
  });
});

const vite: RuntimeSpec = {
  id: "vite",
  label: "Vite",
  appRoot: ".",
  install: "pnpm install",
  dev: "pnpm exec vite --port $PORT --host 0.0.0.0",
  supported: true,
  source: "preset",
};

describe("bancada recipe", () => {
  it("resolves $PORT before the container ever sees it", () => {
    const params = bancadaParameters({ repo: "ccl/arte", branch: "dev", runtime: vite });
    const dev = params.find((p) => p.name === "dev_cmd")!.value;
    assert.equal(dev, "pnpm exec vite --port 5173 --host 0.0.0.0");
    assert.ok(!dev.includes("$PORT"));
  });

  it("refuses a project with no pinned runtime instead of guessing", () => {
    assert.throws(
      () =>
        bancadaParameters({
          repo: "ccl/asgard",
          branch: "main",
          runtime: { ...vite, dev: "" },
        }),
      UnrunnableProject,
    );
  });

  it("refuses a runtime Sleipnir cannot boot, quoting the reason", () => {
    assert.throws(
      () =>
        bancadaParameters({
          repo: "ccl/x",
          branch: "main",
          runtime: { ...vite, supported: false, reason: "python app" },
        }),
      /python app/,
    );
  });

  it("merges runtime env under the control plane's env", () => {
    const params = bancadaParameters({
      repo: "ccl/arte",
      branch: "dev",
      runtime: { ...vite, env: { A: "1", B: "runtime" } },
      env: { B: "control-plane" },
    });
    assert.deepEqual(JSON.parse(params.find((p) => p.name === "extra_env")!.value), {
      A: "1",
      B: "control-plane",
    });
  });

  it("keeps workspace names inside Coder's limit without colliding", () => {
    assert.equal(workspaceName("Arte One", "dev"), "arte-one-dev");
    const a = workspaceName("contorna-ai-landing-page-marketing", "preview");
    const b = workspaceName("contorna-ai-landing-page-mobile", "preview");
    assert.ok(a.length <= 32 && b.length <= 32);
    assert.notEqual(a, b);
    assert.match(a, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
