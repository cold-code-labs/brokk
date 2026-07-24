import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { profileVerifyCmd, resolveE2eGate, type ValidateProfile } from "./profile.js";

describe("profileVerifyCmd", () => {
  it("joins named commands in typecheck → lint → test order", () => {
    const p: ValidateProfile = {
      name: "default",
      commands: {
        test: "pnpm test",
        typecheck: "pnpm typecheck",
        lint: "pnpm lint",
      },
    };
    assert.equal(profileVerifyCmd(p), "pnpm typecheck && pnpm lint && pnpm test");
  });

  it("prefers explicit verify[] when present", () => {
    const p: ValidateProfile = {
      name: "custom",
      commands: {
        typecheck: "ignored",
        verify: ["echo a", "echo b"],
      },
    };
    assert.equal(profileVerifyCmd(p), "echo a && echo b");
  });

  it("skips missing named commands", () => {
    const p: ValidateProfile = {
      name: "lite",
      commands: { typecheck: "tsc -b" },
    };
    assert.equal(profileVerifyCmd(p), "tsc -b");
  });
});

describe("resolveE2eGate", () => {
  function scratch(): string {
    return mkdtempSync(join(tmpdir(), "brokk-e2e-"));
  }

  it("returns none when empty worktree", async () => {
    const cwd = scratch();
    assert.deepEqual(await resolveE2eGate(cwd), { source: "none" });
  });

  it("prefers profile commands.e2e", async () => {
    const cwd = scratch();
    mkdirSync(join(cwd, ".brokk"));
    writeFileSync(
      join(cwd, ".brokk", "profile.json"),
      JSON.stringify({
        name: "app",
        commands: { e2e: "pnpm exec playwright test e2e/smoke.spec.ts" },
      }),
    );
    writeFileSync(join(cwd, "playwright.config.ts"), "export default {}");
    mkdirSync(join(cwd, ".brokk"), { recursive: true });
    writeFileSync(join(cwd, ".brokk", "acceptance.mjs"), "process.exit(0)");
    const gate = await resolveE2eGate(cwd);
    assert.equal(gate.source, "profile");
    if (gate.source === "profile") {
      assert.equal(gate.cmd, "pnpm exec playwright test e2e/smoke.spec.ts");
    }
  });

  it("detects playwright.config.ts", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "playwright.config.ts"), "export default {}");
    const gate = await resolveE2eGate(cwd);
    assert.equal(gate.source, "playwright");
    if (gate.source === "playwright") {
      assert.equal(gate.cmd, "pnpm exec playwright test");
    }
  });

  it("falls back to legacy acceptance.mjs", async () => {
    const cwd = scratch();
    mkdirSync(join(cwd, ".brokk"));
    writeFileSync(join(cwd, ".brokk", "acceptance.mjs"), "process.exit(0)");
    const gate = await resolveE2eGate(cwd);
    assert.equal(gate.source, "legacy-acceptance");
    if (gate.source === "legacy-acceptance") {
      assert.equal(gate.cmd, "node .brokk/acceptance.mjs");
    }
  });
});
