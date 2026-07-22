/**
 * Regression guard for BROKK-21 item 5 (shared pnpm store) — discarded.
 * The worker compose already pins `/home/brokk/work/.pnpm-store`; preview
 * spawns must inherit it, never override to `~/.pnpm-store`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { previewSpawnEnv } from "./preview-env.js";

const WORK_STORE = "/home/brokk/work/.pnpm-store";
const HOME_STORE = "/home/brokk/.pnpm-store";

test("inherits the compose-pinned work store (does not rewrite it)", () => {
  const env = previewSpawnEnv({
    HOME: "/home/brokk",
    npm_config_store_dir: WORK_STORE,
  });
  assert.equal(env.npm_config_store_dir, WORK_STORE);
  assert.notEqual(env.npm_config_store_dir, HOME_STORE);
});

test("does not invent a store when the process has none", () => {
  const env = previewSpawnEnv({ HOME: "/home/brokk" });
  assert.equal(env.npm_config_store_dir, undefined);
});

test("merges app env while keeping the inherited store", () => {
  const env = previewSpawnEnv(
    { HOME: "/home/brokk", npm_config_store_dir: WORK_STORE },
    { PORT: "4100", NODE_ENV: "development" },
  );
  assert.equal(env.npm_config_store_dir, WORK_STORE);
  assert.equal(env.HOME, "/home/brokk");
  assert.equal(env.COREPACK_HOME, "/home/brokk/.cache/corepack");
  assert.equal(env.PORT, "4100");
});

test("falls back to a writable HOME when unset", () => {
  const env = previewSpawnEnv({});
  assert.equal(env.HOME, "/home/brokk");
  assert.equal(env.COREPACK_HOME, "/home/brokk/.cache/corepack");
});
