import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { buildApp } from "../server/app.ts";
import { readConfig } from "../server/config.ts";
import type { PreviewProvider } from "../server/preview.ts";
import { createStore } from "../server/store.ts";
import type {
  Artifact,
  Organization,
  Project,
  User,
} from "../shared/domain.ts";

const url = process.env.BROKK_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.includes("_test"))
  throw new Error("Use an isolated BROKK_TEST_DATABASE_URL containing _test.");
const store = createStore(url),
  cfg = readConfig({
    NODE_ENV: "test",
    BROKK_DATABASE_URL: url,
    BROKK_DEV_AUTH: "1",
    BROKK_VAR_SECRET: "test-integration-only",
  }),
  app = buildApp(store, cfg);
let admin = "",
  operator = "",
  client = "",
  reader = "",
  stranger = "",
  org: Organization,
  project: Project;
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = admin,
  origin = cfg.origin,
) {
  return app.request(`/api${path}`, {
    method,
    headers: { cookie, origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function login(email: string) {
  const r = await call("/auth/dev", "POST", { email }, "");
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie.split(";")[0];
}
async function record(
  kind: string,
  title: string,
  data: Record<string, unknown> = {},
  status = "draft",
) {
  const r = await call(`/projects/${project.id}/records`, "POST", {
    kind,
    title,
    status,
    data,
  });
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()) as Artifact;
}
before(async () => {
  await store.migrate();
  await store.sql`truncate brokk_v2.organizations,brokk_v2.members,brokk_v2.projects,brokk_v2.artifacts,brokk_v2.events,brokk_v2.versions,brokk_v2.sessions,brokk_v2.tickets cascade`;
  admin = await login("admin@local.test");
  operator = await login("operator@local.test");
  client = await login("client@local.test");
  reader = await login("reader@local.test");
  stranger = await login("stranger@local.test");
  org = await (
    await call("/organizations", "POST", { name: "Organization A" })
  ).json();
  for (const [email, role] of [
    ["operator@local.test", "operator"],
    ["client@local.test", "client"],
    ["reader@local.test", "reader"],
  ])
    assert.equal(
      (await call(`/organizations/${org.id}/members`, "POST", { email, role }))
        .status,
      200,
    );
  project = await (
    await call("/projects", "POST", {
      organizationId: org.id,
      name: "Project A",
      objective: "Build a scoped product",
    })
  ).json();
});
after(() => store.close());

test("requires authentication, rejects crossed origin and unexpected fields", async () => {
  assert.equal((await call("/projects", "GET", undefined, "")).status, 401);
  assert.equal(
    (
      await call(
        "/organizations",
        "POST",
        { name: "X" },
        admin,
        "https://evil.example",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/projects", "POST", {
        organizationId: org.id,
        name: "X",
        objective: "",
        repository: "secret/infra",
      })
    ).status,
    400,
  );
});
test("organization isolation includes lists, IDs, versions and provider endpoints", async () => {
  assert.deepEqual(
    await (await call("/projects", "GET", undefined, stranger)).json(),
    [],
  );
  for (const route of [
    `/projects/${project.id}`,
    `/projects/${project.id}/records/${randomUUID()}/versions`,
    `/projects/${project.id}/events`,
  ])
    assert.equal((await call(route, "GET", undefined, stranger)).status, 404);
  const other = (await (
    await call("/organizations", "POST", { name: "Organization B" })
  ).json()) as Organization;
  const otherProject = (await (
    await call("/projects", "POST", {
      organizationId: other.id,
      name: "Other",
      objective: "",
    })
  ).json()) as Project;
  assert.equal(
    (await call(`/projects/${otherProject.id}`, "GET", undefined, operator))
      .status,
    404,
  );
});
test("operator cannot grant access or connect a repository; reader cannot edit", async () => {
  assert.equal(
    (
      await call(
        `/organizations/${org.id}/members`,
        "POST",
        { email: "reader@local.test", role: "admin" },
        operator,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/projects/${project.id}/repository`,
        "PUT",
        { repository: "org/repo" },
        operator,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/projects/${project.id}/records`,
        "POST",
        { kind: "task", title: "Task", status: "backlog", data: {} },
        reader,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/projects/${project.id}/records`,
        "POST",
        {
          kind: "feedback",
          title: "Client feedback",
          status: "draft",
          data: { body: "Please improve the flow." },
        },
        client,
      )
    ).status,
    201,
  );
});
test("versioned scope survives reload, receives client approval and reopens after edit", async () => {
  const scope = await record("scope", "Scope", {
    body: "Deliver the portal",
    acceptance: "Client can review securely",
  });
  const review = await record(
    "review",
    "Review scope",
    { targetId: scope.id, targetVersion: scope.version },
    "review",
  );
  assert.equal(
    (
      await call(
        `/projects/${project.id}/reviews/${review.id}/decision`,
        "POST",
        { version: 1, decision: "approved", feedback: "Approved" },
        client,
      )
    ).status,
    200,
  );
  const edit = await call(
    `/projects/${project.id}/records/${scope.id}`,
    "PATCH",
    {
      version: 1,
      title: "Scope",
      status: "draft",
      data: { body: "Changed scope" },
    },
    operator,
  );
  assert.equal(edit.status, 200);
  const updated = (await edit.json()) as Artifact;
  assert.equal(updated.version, 2);
  assert.equal(updated.status, "draft");
  assert.equal(
    (
      await call(
        `/projects/${project.id}/records/${scope.id}`,
        "PATCH",
        { version: 1, title: "Lost write", status: "draft", data: {} },
        operator,
      )
    ).status,
    409,
  );
  const ws = await (await call(`/projects/${project.id}`)).json();
  assert.equal(
    ws.records.find((x: Artifact) => x.id === review.id).status,
    "changes",
  );
  const versions = await (
    await call(`/projects/${project.id}/records/${scope.id}/versions`)
  ).json();
  assert.equal(versions.length, 2);
  assert.equal(versions[1].snapshot.data.body, "Deliver the portal");
  assert.equal(
    (
      await call(
        `/projects/${project.id}/reviews/${review.id}/decision`,
        "POST",
        { version: 3, decision: "approved", feedback: "" },
        client,
      )
    ).status,
    409,
  );
});
test("call notes retain authors and close atomically creates exactly one task per adjustment", async () => {
  const screen = await record("screen", "Dashboard", {
    body: "Accessible summary",
  });
  const room = await record("call", "Client review", {}, "scheduled");
  const note = await call(
    `/projects/${project.id}/calls/${room.id}/notes`,
    "POST",
    {
      version: room.version,
      body: "Increase contrast",
      category: "change",
      screenId: screen.id,
    },
    client,
  );
  assert.equal(note.status, 200);
  const updated = (await note.json()) as Artifact;
  assert.equal(updated.data.notes[0].author, "client@local.test");
  assert.equal(
    (
      await call(
        `/projects/${project.id}/calls/${room.id}/close`,
        "POST",
        { version: updated.version },
        client,
      )
    ).status,
    403,
  );
  const closed = await call(
    `/projects/${project.id}/calls/${room.id}/close`,
    "POST",
    { version: updated.version },
    operator,
  );
  assert.equal(closed.status, 200);
  const result = await closed.json();
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].data.screenId, screen.id);
  assert.equal(result.call.data.notes.length, 1);
  assert.equal(
    (
      await call(
        `/projects/${project.id}/calls/${room.id}/close`,
        "POST",
        { version: result.call.version },
        operator,
      )
    ).status,
    409,
  );
});
test("run reservation is durable and concurrent duplicate clicks cannot create another paid job", async () => {
  const task = await record(
    "task",
    "Develop task",
    { acceptance: "Check UI" },
    "backlog",
  );
  const user: User = {
    id: "local:operator",
    email: "operator@local.test",
    name: "Operator",
    admin: false,
  };
  const key = randomUUID();
  const outcomes = await Promise.all([
    store.reserveRun(project.id, task.id, key, user, 20),
    store.reserveRun(project.id, task.id, key, user, 20),
  ]);
  assert.equal(outcomes.filter((x) => x.created).length, 1);
  assert.equal(outcomes[0].run.id, outcomes[1].run.id);
  await assert.rejects(
    store.reserveRun(project.id, task.id, randomUUID(), user, 20),
    /andamento/,
  );
  assert.equal(
    (
      await call(
        `/projects/${project.id}/development`,
        "POST",
        { taskId: task.id, requestKey: randomUUID() },
        client,
      )
    ).status,
    503,
  );
});
test("Var handoff is server-only, organization-scoped, idempotent and single-use", async () => {
  const body = {
    organizationId: "var-company-a",
    organizationName: "Var Company",
    projectId: "var-project-a",
    projectName: "Var Project",
    objective: "Authorized context",
    email: "var-operator@local.test",
    name: "Var operator",
    role: "operator",
  };
  assert.equal(
    (await call("/integrations/var/handoff", "POST", body, "")).status,
    401,
  );
  const handoff = async () =>
    app.request("/api/integrations/var/handoff", {
      method: "POST",
      headers: {
        authorization: "Bearer test-integration-only",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const first = await (await handoff()).json(),
    second = await (await handoff()).json();
  assert.equal(first.projectId, second.projectId);
  const route = new URL(first.url).pathname + new URL(first.url).search;
  const redeemed = await app.request(route);
  assert.equal(redeemed.status, 302);
  assert.equal((await app.request(route)).status, 401);
  const rawCookie = redeemed.headers.get("set-cookie");
  assert.ok(rawCookie);
  const cookie = rawCookie.split(";")[0];
  const ws = await (
    await call(`/projects/${first.projectId}`, "GET", undefined, cookie)
  ).json();
  assert.equal(ws.organization.externalId, "var-company-a");
  assert.equal(ws.organization.role, "operator");
  assert.equal(
    (await call(`/projects/${project.id}`, "GET", undefined, cookie)).status,
    404,
  );
});
test("production refuses development identity and incomplete auth config", () => {
  assert.throws(
    () =>
      readConfig({
        NODE_ENV: "production",
        BROKK_DATABASE_URL: url,
        BROKK_DEV_AUTH: "1",
      }),
    /Production requires/,
  );
  const prod = readConfig({
    NODE_ENV: "production",
    BROKK_DATABASE_URL: url,
    BROKK_ORIGIN: "https://brokk.example",
    LOGTO_ENDPOINT: "https://auth.example",
    LOGTO_APP_ID: "test",
    LOGTO_APP_SECRET: "test",
    BROKK_ADMIN_EMAILS: "admin@example.com",
    BROKK_DEV_AUTH: "1",
  });
  assert.equal(prod.devAuth, false);
});

test("design system import is atomic, idempotent, tenant-scoped and read-only for clients", async () => {
  const { nfcsManifest } = await import("../shared/examples/nfcs.ts");
  const nfcs = (await (
    await call("/projects", "POST", {
      organizationId: org.id,
      name: "NFCS · Design System",
      objective: "Validate the NFCS contract",
    })
  ).json()) as Project;
  const path = `/projects/${nfcs.id}/design`;
  assert.equal((await call(path, "GET", undefined, stranger)).status, 404);
  assert.equal(
    (await call(`${path}/import`, "POST", nfcsManifest, client)).status,
    403,
  );
  assert.equal(
    (await call(`${path}/import`, "POST", nfcsManifest, reader)).status,
    403,
  );
  const imported = await call(`${path}/import`, "POST", nfcsManifest, operator);
  assert.equal(imported.status, 201, await imported.clone().text());
  assert.equal((await imported.json()).imported, 108);
  const repeated = await call(`${path}/import`, "POST", nfcsManifest, operator);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).imported, 0);
  const contract = await (await call(path, "GET", undefined, reader)).json();
  assert.equal(contract.validation.valid, true);
  assert.equal(contract.validation.counts.tokens, 86);
  assert.equal(contract.components.length, 16);
  assert.equal(
    (await call(`${path}/export?format=tokens`, "GET", undefined, stranger))
      .status,
    404,
  );
  const tokens = await call(`${path}/export?format=tokens`);
  assert.equal(tokens.status, 200);
  assert.match(
    tokens.headers.get("Content-Type") || "",
    /application\/design-tokens\+json/,
  );
  assert.equal(
    (await tokens.json()).color.surface.highlight.$value,
    "{color.highlight.yellow}",
  );
  const ws = await (await call(`/projects/${nfcs.id}`)).json();
  const yellow = ws.records.find(
    (x: Artifact) => x.data.design?.key === "color.highlight.yellow",
  ) as Artifact;
  const grifo = ws.records.find(
    (x: Artifact) => x.data.design?.key === "text.grifo",
  ) as Artifact;
  const broken = structuredClone(yellow.data.design);
  if (broken?.kind === "token") broken.value = "{font.family.body}";
  const failed = await call(
    `/projects/${nfcs.id}/records/${yellow.id}`,
    "PATCH",
    {
      version: yellow.version,
      title: yellow.title,
      status: "draft",
      data: { design: broken },
    },
  );
  assert.equal(failed.status, 400);
  const unchanged = await (await call(path)).json();
  assert.equal(unchanged.checksum, contract.checksum);
  const review = (await (
    await call(`/projects/${nfcs.id}/records`, "POST", {
      kind: "review",
      title: "Revisão do grifo",
      status: "review",
      data: { targetId: grifo.id, targetVersion: grifo.version },
    })
  ).json()) as Artifact;
  assert.equal(
    (
      await call(
        `/projects/${nfcs.id}/reviews/${review.id}/decision`,
        "POST",
        {
          version: review.version,
          decision: "approved",
          feedback: "Approved design",
        },
        client,
      )
    ).status,
    200,
  );
  const next = structuredClone(yellow.data.design);
  if (next?.kind === "token") next.value = "#efc72e";
  const change = await call(
    `/projects/${nfcs.id}/records/${yellow.id}`,
    "PATCH",
    {
      version: yellow.version,
      title: yellow.title,
      status: "draft",
      data: {
        body: yellow.data.body,
        acceptance: yellow.data.acceptance,
        design: next,
      },
    },
    operator,
  );
  assert.equal(change.status, 200, await change.clone().text());
  const updated = await (await call(path)).json();
  assert.equal(updated.resolvedTokens["color.surface.highlight"], "#efc72e");
  assert.notEqual(updated.checksum, contract.checksum);
  const current = await (await call(`/projects/${nfcs.id}`)).json();
  assert.equal(
    current.records.find((x: Artifact) => x.id === grifo.id).version,
    grifo.version + 1,
  );
  assert.equal(
    current.records.find((x: Artifact) => x.id === grifo.id).status,
    "draft",
  );
  assert.equal(
    current.records.find((x: Artifact) => x.id === review.id).status,
    "changes",
  );
  const history = await (
    await call(`/projects/${nfcs.id}/records/${grifo.id}/versions`)
  ).json();
  assert.equal(history.length, 2);
  assert.ok(history[0].snapshot.data.design);
  const snapshot = await call(`${path}/export?format=contract`);
  assert.equal((await snapshot.json()).checksum, updated.checksum);
  const conflict = await call(
    `/projects/${nfcs.id}/records/${yellow.id}`,
    "PATCH",
    {
      version: yellow.version,
      title: yellow.title,
      status: "draft",
      data: { design: next },
    },
  );
  assert.equal(conflict.status, 409);
  const evil = structuredClone(nfcsManifest);
  evil.items[0].design.key = "color.some.unknown";
  const before = current.records.length;
  assert.equal((await call(`${path}/import`, "POST", evil)).status, 409);
  assert.equal(
    (await (await call(`/projects/${nfcs.id}`)).json()).records.length,
    before,
  );
  const other = await (
    await call("/projects", "POST", {
      organizationId: org.id,
      name: "Empty reference",
      objective: "Atomic failure",
    })
  ).json();
  const incomplete = structuredClone(nfcsManifest);
  incomplete.items = incomplete.items.filter(
    (x) => x.design.key !== "color.highlight.yellow",
  );
  assert.equal(
    (await call(`/projects/${other.id}/design/import`, "POST", incomplete))
      .status,
    400,
  );
  assert.equal(
    (await (await call(`/projects/${other.id}`)).json()).records.length,
    0,
  );
  assert.equal(
    (await call(`/projects/${other.id}/design/export?format=contract`)).status,
    409,
  );
});

test("preview preparation is scoped, idempotent and hides provider capabilities", async () => {
  const previewCfg = readConfig({
    NODE_ENV: "test",
    BROKK_DATABASE_URL: url,
    BROKK_DEV_AUTH: "1",
    BROKK_COOLIFY_URL: "https://engine.test/api/v1",
    BROKK_COOLIFY_TOKEN: "private-engine-token",
    BROKK_COOLIFY_PROJECT: "private-project",
    BROKK_COOLIFY_SERVER: "private-server",
    BROKK_COOLIFY_GITHUB_APP: "private-app",
    BROKK_HAULDR_URL: "https://backend.test",
    BROKK_HAULDR_KEY: "private-backend-key",
    BROKK_GITHUB_TOKEN: "private-git-key",
    BROKK_REPOSITORY_OWNER: "cold-code-labs",
    BROKK_REPOSITORY_TEMPLATE: "cold-code-labs/template-vite",
    BROKK_PREVIEW_DOMAIN: "preview.example.test",
    BROKK_PREVIEW_ALIAS_DOMAIN: "example.test",
    BROKK_WOODPECKER_URL: "https://ci.test/api",
    BROKK_WOODPECKER_TOKEN: "private-ci-key",
  });
  let preparations = 0,
    publishes = 0;
  const provider: PreviewProvider = {
    async prepare(env, save) {
      preparations++;
      return save({
        state: "waiting",
        step: "prepared",
        dataReady: true,
        resources: {
          application: "private-resource",
          dataProject: `${env.slug}_dev`,
          deployment: "",
        },
        detail: "Prepared",
      });
    },
    async inspect() {
      return {
        state: "ready",
        step: "verified",
        ciState: "success",
        commit: "a".repeat(40),
        deployedCommit: "a".repeat(40),
      };
    },
    async deploy() {
      publishes++;
      return "private-deployment";
    },
    async pullRequests() {
      return [];
    },
    async merge() {
      throw new Error("unexpected integration");
    },
  };
  const envApp = buildApp(store, previewCfg, { preview: provider });
  const ec = (path: string, method = "GET", body?: unknown, cookie = admin) =>
    envApp.request(`/api${path}`, {
      method,
      headers: {
        cookie,
        origin: previewCfg.origin,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const p = (await (
    await call("/projects", "POST", {
      organizationId: org.id,
      name: "Preview isolation",
      objective: "Verify preview lifecycle.",
    })
  ).json()) as Project;
  const path = `/projects/${p.id}/environment`;
  assert.equal(
    (await ec(path, "PUT", { slug: "scoped-test" }, operator)).status,
    403,
  );
  assert.equal((await ec(`${path}/prepare`, "POST", {}, client)).status, 403);
  assert.equal((await ec(`${path}/prepare`, "POST", {}, reader)).status, 403);
  assert.equal((await ec(path, "GET", undefined, stranger)).status, 404);
  const configured = await ec(path, "PUT", {
    slug: "scoped-test",
    hostname: "scoped-test-preview.example.test",
    productionUrl: "https://scoped-test.example.test",
    profile: "static",
  });
  assert.equal(configured.status, 200, await configured.clone().text());
  assert.equal(
    (await ec(path, "PUT", { slug: "other-test", profile: "static" })).status,
    409,
  );
  assert.equal(
    (
      await call(`/projects/${p.id}/repository`, "PUT", {
        repository: "cold-code-labs/another",
      })
    ).status,
    409,
  );
  const requests = await Promise.all([
    ec(`${path}/prepare`, "POST", {}, operator),
    ec(`${path}/prepare`, "POST", {}, operator),
  ]);
  assert.ok(requests.every((r) => [200, 202].includes(r.status)));
  for (let i = 0; i < 20; i++) {
    const view = await (await ec(path)).json();
    if (view.environment?.state === "waiting") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(preparations, 1);
  assert.equal((await ec(`${path}/prepare`, "POST", {}, operator)).status, 200);
  assert.equal(preparations, 1);
  const view = await ec(path, "GET", undefined, client),
    text = await view.text();
  assert.equal(view.status, 200);
  for (const secret of [
    "private-resource",
    "private-engine-token",
    "private-backend-key",
    "private-ci-key",
    '"lease"',
    '"resources"',
  ])
    assert.ok(!text.includes(secret), secret);
  assert.equal((await ec(`${path}/publish`, "POST", {}, client)).status, 403);
  assert.equal((await ec(`${path}/refresh`, "POST", {}, operator)).status, 200);
  assert.equal((await ec(`${path}/publish`, "POST", {}, operator)).status, 202);
  assert.equal(publishes, 1);
  assert.equal(
    (
      await ec(
        `${path}/integrate`,
        "POST",
        { runId: randomUUID(), head: "a".repeat(40) },
        operator,
      )
    ).status,
    409,
  );
  const duplicate = (await (
    await call("/projects", "POST", {
      organizationId: org.id,
      name: "Collision",
      objective: "",
    })
  ).json()) as Project;
  assert.equal(
    (
      await ec(`/projects/${duplicate.id}/environment`, "PUT", {
        slug: "scoped-test",
        hostname: "scoped-test-preview.example.test",
        productionUrl: "https://scoped-test.example.test",
        profile: "static",
      })
    ).status,
    409,
  );
});

test("Devin reconciliation is administrative, never launches and preserves incomplete results", async () => {
  const task = await record("task", "Reconcile launch", {}, "ready");
  const user: User = {
    id: "local:operator",
    email: "operator@local.test",
    name: "Operator",
    admin: false,
  };
  const run = (
    await store.reserveRun(project.id, task.id, randomUUID(), user, 20)
  ).run;
  await store.providerUpdate(project.id, run.id, user, "uncertain", {
    providerStatus: "creation_unconfirmed",
  });
  const dc = readConfig({
    NODE_ENV: "test",
    BROKK_DATABASE_URL: url,
    BROKK_DEV_AUTH: "1",
    DEVIN_API_KEY: "test-key",
    DEVIN_ORG_ID: "org-test",
  });
  const da = buildApp(store, dc),
    original = globalThis.fetch;
  const path = `/api/projects/${project.id}/development/${run.id}/reconcile`;
  const request = (cookie: string) =>
    da.request(path, {
      method: "POST",
      headers: {
        cookie,
        origin: dc.origin,
        "content-type": "application/json",
      },
      body: "{}",
    });
  let complete = false,
    calls = 0;
  globalThis.fetch = async (_input, options) => {
    calls++;
    assert.equal(options?.method, "GET");
    return new Response(
      JSON.stringify({ items: [], total: 0, has_next_page: !complete }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    assert.equal((await request(operator)).status, 403);
    assert.equal((await request(client)).status, 403);
    assert.equal((await request(stranger)).status, 404);
    assert.equal(calls, 0);
    assert.equal((await request(admin)).status, 409);
    assert.equal(
      (await store.workspace(project.id, user)).records.find(
        (r) => r.id === run.id,
      )?.status,
      "uncertain",
    );
    complete = true;
    const result = await request(admin);
    assert.equal(result.status, 200);
    assert.equal(
      (await result.json()).data.providerStatus,
      "reconciled_absent",
    );
    assert.equal((await request(admin)).status, 409);
    assert.equal(calls, 2);
    assert.equal(
      (await store.reserveRun(project.id, task.id, randomUUID(), user, 20))
        .created,
      true,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Cursor jobs use private single-owner leases and scoped messages without paid retries", async () => {
  const task = await record("task", "Cursor reconstruction", {}, "ready");
  const user: User = {
    id: "local:operator",
    email: "operator@local.test",
    name: "Operator",
    admin: false,
  };
  const technical: User = {
    id: "local:admin@local.test",
    email: "admin@local.test",
    name: "Admin",
    admin: true,
  };
  await store.configureEnvironment(
    project.id,
    {
      slug: "cursor-scope",
      repository: "cold-code-labs/cursor-scope",
      previewUrl: "https://cursor-scope.preview.example.test",
      productionUrl: "",
      profile: "static",
    },
    technical,
    30,
  );
  const reservation = await store.reserveEnvironment(project.id, technical);
  await store.environmentUpdate(
    project.id,
    reservation.environment.lease,
    {
      state: "waiting",
      step: "prepared",
      dataReady: true,
      resources: {
        application: "private-app",
        dataProject: "cursor-scope_dev",
        deployment: "",
      },
    },
    technical,
  );
  const run = (
    await store.reserveRun(
      project.id,
      task.id,
      randomUUID(),
      user,
      20,
      "Exact complete contract",
      undefined,
      "cursor",
    )
  ).run;
  const cc = readConfig({
    NODE_ENV: "test",
    BROKK_DATABASE_URL: url,
    BROKK_DEV_AUTH: "1",
    BROKK_CURSOR_WORKER_SECRET: "private-worker-key",
  });
  const ca = buildApp(store, cc);
  const wr = (path: string, body: unknown, key = "private-worker-key") =>
    ca.request(`/api/worker/cursor/${path}`, {
      method: "POST",
      headers: {
        origin: cc.origin,
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await wr("claim", { owner: "test-worker" }, "wrong-key")).status,
    401,
  );
  const claims = await Promise.all([
    wr("claim", { owner: "test-worker" }),
    wr("claim", { owner: "other-worker" }),
  ]);
  const jobs = await Promise.all(claims.map((r) => r.json()));
  assert.equal(jobs.filter(Boolean).length, 1);
  const job = jobs.find(Boolean);
  assert.equal(job.runId, run.id);
  assert.equal(job.prompt, "Exact complete contract");
  assert.equal(
    (await wr(`${run.id}/report`, { lease: "f".repeat(64) })).status,
    409,
  );
  const msg = await ca.request(
    `/api/projects/${project.id}/development/${run.id}/messages`,
    {
      method: "POST",
      headers: {
        cookie: operator,
        origin: cc.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Preserve the Aurora layout." }),
    },
  );
  assert.equal(msg.status, 200);
  const heartbeat = await wr(`${run.id}/report`, { lease: job.lease });
  assert.equal(
    (await heartbeat.json()).messages[0].body,
    "Preserve the Aurora layout.",
  );
  assert.equal(
    (
      await wr(`${run.id}/report`, {
        lease: job.lease,
        state: "review",
        resultUrl: "https://github.com/another/repo/pull/1",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await wr(`${run.id}/report`, {
        lease: job.lease,
        state: "failed",
        message: "Worker stopped without publishing.",
      })
    ).status,
    200,
  );
  assert.equal(
    (await wr(`${run.id}/report`, { lease: job.lease })).status,
    409,
  );
  const ws = await store.workspace(project.id, user);
  assert.ok(!JSON.stringify(ws).includes(job.lease));
  assert.equal(ws.records.find((r) => r.id === run.id)?.status, "failed");
});
