/**
 * redactEnv — Env inspector must never echo PATs / tokens in clear (BROKK-29).
 * Run: `pnpm --filter @brokk/forge-app test`
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactEnv } from "./preview.js";

test("redactEnv masks COOLIFY_PAT (and other *_PAT keys)", () => {
  const out = redactEnv({
    COOLIFY_PAT: "super-secret-coolify-pat-value",
    GITHUB_PAT: "ghp_abcdefghijklmnopqrstuvwxyz",
    PATH: "/usr/bin:/bin",
  });
  assert.match(out.COOLIFY_PAT, /^••••/);
  assert.doesNotMatch(out.COOLIFY_PAT, /super-secret/);
  assert.match(out.GITHUB_PAT, /^••••/);
  assert.equal(out.PATH, "/usr/bin:/bin");
});

test("redactEnv still masks classic secret keys and connection passwords", () => {
  const out = redactEnv({
    API_TOKEN: "tok_live_abcdef",
    DATABASE_URL: "postgres://app:s3cret@db:5432/x",
    VITE_HAULDR_URL: "https://hauldr.example",
  });
  assert.match(out.API_TOKEN, /^••••/);
  assert.match(out.DATABASE_URL, /:\/\/app:••••@/);
  assert.equal(out.VITE_HAULDR_URL, "https://hauldr.example");
});
