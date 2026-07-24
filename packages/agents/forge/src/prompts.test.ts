import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHealPrompt, summarizeVerifyFailure } from "./prompts.js";
import type { AgentRunContext } from "@brokk/core";

const fakeCtx = {
  task: {
    title: "[sec] other-invalid-input — deepsec",
    body: "fix dates",
    acceptance: "invalid ISO → 400",
    labels: ["svalinn"],
  },
} as unknown as AgentRunContext;

describe("summarizeVerifyFailure", () => {
  it("keeps ERR_PNPM_IGNORED_BUILDS and drops the dependency install dump", () => {
    const deps = Array.from({ length: 40 }, (_, i) => `+ @radix-ui/react-thing-${i} 1.0.${i}`).join("\n");
    const raw = [
      "? Verifying lockfile...",
      "Packages: +252",
      deps,
      "✔ Generated Prisma Client",
      "",
      "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @prisma/client@6.19.3, prisma@6.19.3",
      "",
      'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
      "",
      "Command failed: pnpm install --no-frozen-lockfile --prod=false && pnpm -r typecheck",
    ].join("\n");

    const summary = summarizeVerifyFailure(raw);
    assert.match(summary, /ERR_PNPM_IGNORED_BUILDS/);
    assert.match(summary, /strict-dep-builds=false/);
    assert.match(summary, /Do NOT invent `pnpm-workspace\.yaml`/);
    assert.ok(summary.length < raw.length / 2, "summary should be much shorter than the install dump");
    assert.doesNotMatch(summary, /@radix-ui\/react-thing-20/);
  });

  it("hints when typecheck script is missing", () => {
    const summary = summarizeVerifyFailure('ERR_PNPM_NO_SCRIPT Missing script: "typecheck"');
    assert.match(summary, /no `typecheck` script/i);
    assert.match(summary, /tsc --noEmit/);
  });
});

describe("buildHealPrompt", () => {
  it("feeds the agent a summarized failure, not a 12k install dump", () => {
    const dump = `${"Progress: resolved 252\n".repeat(200)}[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: prisma\n`;
    const prompt = buildHealPrompt(fakeCtx, dump);
    assert.match(prompt, /VERIFICATION FAILED/);
    assert.match(prompt, /ERR_PNPM_IGNORED_BUILDS/);
    assert.ok(prompt.length < 8000, `heal prompt still too large: ${prompt.length}`);
    assert.doesNotMatch(prompt, /Progress: resolved 252\nProgress: resolved 252\nProgress: resolved 252\nProgress: resolved 252\nProgress: resolved 252/);
  });
});
