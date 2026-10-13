import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../server/config.ts";
import { DevinRejection, devin } from "../server/providers.ts";

const cfg = readConfig({
  NODE_ENV: "test",
  BROKK_DATABASE_URL: "postgres://unused/db_test",
  DEVIN_API_KEY: "test-key",
  DEVIN_ORG_ID: "org-test",
});
test("explicit Devin validation rejection is distinguished from ambiguous failures", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [400, 401, 403, 404, 422, 429]) {
      globalThis.fetch = async () =>
        new Response("private vendor body", { status });
      await assert.rejects(
        () => devin(cfg, "", "POST", {}),
        (e: unknown) =>
          e instanceof DevinRejection &&
          e.upstreamStatus === status &&
          !e.message.includes("private vendor body"),
      );
    }
    for (const status of [408, 409, 500, 502]) {
      globalThis.fetch = async () =>
        new Response("private vendor body", { status });
      await assert.rejects(
        () => devin(cfg, "", "POST", {}),
        (e: unknown) => e instanceof Error && !(e instanceof DevinRejection),
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
