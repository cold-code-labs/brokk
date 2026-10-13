import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { buildApp } from "../server/app.ts";
import { readConfig } from "../server/config.ts";
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
