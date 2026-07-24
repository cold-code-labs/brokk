import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { profileVerifyCmd, type ValidateProfile } from "./profile.js";

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
