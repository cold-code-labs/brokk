/**
 * apply_migration — auth failures must be loud (BROKK-14). Run:
 * `pnpm --filter @brokk/forge exec tsx --test src/tools.test.ts`
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { makeMigrationExecutor } from "./tools.js";

let cwd: string;
const originalFetch = globalThis.fetch;

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "brokk-mig-"));
});

after(async () => {
  globalThis.fetch = originalFetch;
  await rm(cwd, { recursive: true, force: true });
});

test("apply_migration: 401 → AUTH FAILED (never a quiet status line)", async () => {
  globalThis.fetch = (async () =>
    new Response("token rejected", { status: 401 })) as typeof fetch;

  const exec = makeMigrationExecutor({
    cwd,
    controlUrl: "https://hauldr.example",
    token: "dead-management-key",
    project: "demo_dev",
  });
  const res = await exec("apply_migration", {
    name: "add_widgets",
    sql: "create table if not exists widgets (id uuid primary key);",
  });
  assert.equal(res?.ok, false);
  assert.match(res?.content ?? "", /AUTH FAILED/);
  assert.match(res?.content ?? "", /migrate token|HAULDR_TOKEN/i);
  assert.match(res?.content ?? "", /Do not retry/);
});
