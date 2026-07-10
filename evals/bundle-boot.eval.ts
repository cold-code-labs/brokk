// Bundle-boot check (post-incident 2026-07-10): esbuild inlines the CJS deps
// of noExternal-bundled workspace packages, and a dynamic require()/__filename
// in them crashes the ESM bundle AT BOOT — typecheck and unit tests never see
// it. Build the worker bundles and boot them with no env: a healthy bundle
// dies at config validation; a broken one dies at module load.

import { execFileSync, spawnSync } from "node:child_process";
import { expect, type EvalTask } from "./harness.js";

const ROOT = new URL("..", import.meta.url).pathname;

function bootDies(bundle: string): string {
  const r = spawnSync("node", [bundle], {
    cwd: ROOT,
    timeout: 15_000,
    encoding: "utf8",
    env: { PATH: process.env.PATH }, // deliberately bare — config must reject
  });
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
}

function check(id: string, filter: string, bundle: string): void {
  execFileSync("pnpm", ["--filter", filter, "build"], { cwd: ROOT, stdio: "pipe", timeout: 180_000 });
  const out = bootDies(bundle);
  expect(
    !/Dynamic require of|__filename is not defined|__dirname is not defined|Cannot find module/.test(out),
    `${id}: bundle failed at MODULE LOAD:\n${out.slice(0, 600)}`,
  );
  expect(
    /Required|required|Invalid configuration/.test(out),
    `${id}: expected an env-validation death, got:\n${out.slice(0, 600)}`,
  );
}

export const buildTasks: EvalTask[] = [
  {
    id: "bundle-boot-chat",
    lane: "build",
    timeoutMs: 240_000,
    async run() {
      check("chat", "@brokk/chat-app", "apps/chat/dist/index.js");
    },
  },
  {
    id: "bundle-boot-forge",
    lane: "build",
    timeoutMs: 240_000,
    async run() {
      check("forge", "@brokk/forge-app", "apps/forge/dist/index.js");
    },
  },
];
