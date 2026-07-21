/**
 * redactEnv — API must never return Coolify/GitHub PATs in clear (BROKK-29).
 * Run: `pnpm --filter @brokk/api test`
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactEnv, redactPreviewEnv } from "./secrets.js";

test("redactEnv masks COOLIFY_PAT on the API boundary", () => {
  const out = redactEnv({
    COOLIFY_PAT: "super-secret-coolify-pat-value",
    PATH: "/usr/bin",
  });
  assert.match(out.COOLIFY_PAT, /^••••/);
  assert.doesNotMatch(out.COOLIFY_PAT, /super-secret/);
  assert.equal(out.PATH, "/usr/bin");
});

test("redactPreviewEnv leaves null loadedEnv alone", () => {
  const p = { id: "x", loadedEnv: null as Record<string, string> | null };
  assert.equal(redactPreviewEnv(p), p);
});

test("redactPreviewEnv redacts nested loadedEnv", () => {
  const out = redactPreviewEnv({
    id: "x",
    loadedEnv: { COOLIFY_PAT: "leak-me-please-now", VITE_URL: "https://x" },
  });
  assert.match(out.loadedEnv!.COOLIFY_PAT, /^••••/);
  assert.equal(out.loadedEnv!.VITE_URL, "https://x");
});
