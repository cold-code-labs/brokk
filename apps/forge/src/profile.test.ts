import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractProfileFromLabels, loadAllProfiles, loadValidateProfile, profileVerifyCmd, resolveVerifyCmd, type ValidateProfile } from "./profile.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("extractProfileFromLabels", () => {
  it("extracts profile name from profile:<name> label", () => {
    const labels = ["bug", "profile:ci", "priority:high"];
    assert.equal(extractProfileFromLabels(labels), "ci");
  });

  it("returns null when no profile label found", () => {
    const labels = ["bug", "priority:high", "type:feature"];
    assert.equal(extractProfileFromLabels(labels), null);
  });

  it("returns null for empty labels", () => {
    assert.equal(extractProfileFromLabels([]), null);
  });

  it("returns first profile label when multiple exist", () => {
    const labels = ["profile:fast", "profile:ci"];
    assert.equal(extractProfileFromLabels(labels), "fast");
  });

  it("handles profile labels with special characters", () => {
    const labels = ["profile:my-project-v2"];
    assert.equal(extractProfileFromLabels(labels), "my-project-v2");
  });
});

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

describe("loadAllProfiles", () => {
  let testDir: string;
  
  it("loads profiles from .brokk/profiles/ directory", async () => {
    testDir = join(tmpdir(), `test-profiles-dir-${Date.now()}`);
    const brokkDir = join(testDir, ".brokk", "profiles");
    await mkdir(brokkDir, { recursive: true });
    
    // Create test profiles
    await writeFile(join(brokkDir, "ci.json"), JSON.stringify({
      name: "ci",
      commands: { typecheck: "tsc -b", test: "jest" }
    }));
    await writeFile(join(brokkDir, "fast.json"), JSON.stringify({
      name: "fast",
      commands: { verify: ["echo fast"] }
    }));
    
    const profiles = await loadAllProfiles(testDir);
    assert.deepStrictEqual(Object.keys(profiles).sort(), ["ci", "fast"]);
    assert.equal(profiles.ci.name, "ci");
    assert.equal(profiles.fast.name, "fast");
    
    await rm(testDir, { recursive: true, force: true });
  });
  
  it("loads profiles from profile.json profiles map", async () => {
    testDir = join(tmpdir(), `test-profiles-map-${Date.now()}`);
    const brokkDir = join(testDir, ".brokk");
    await mkdir(brokkDir, { recursive: true });
    
    // Create profile.json with profiles map
    await writeFile(join(brokkDir, "profile.json"), JSON.stringify({
      name: "default",
      profiles: {
        "ci": { commands: { typecheck: "tsc -b" } },
        "lint-only": { commands: { lint: "eslint ." } }
      }
    }));
    
    const profiles = await loadAllProfiles(testDir);
    assert.deepStrictEqual(Object.keys(profiles).sort(), ["ci", "default", "lint-only"]);
    assert.equal(profiles.default.name, "default");
    assert.equal(profiles.ci.name, "ci");
    assert.equal(profiles["lint-only"].name, "lint-only");
    
    await rm(testDir, { recursive: true, force: true });
  });
  
  it("directory profiles take precedence over map profiles", async () => {
    testDir = join(tmpdir(), `test-profiles-precedence-${Date.now()}`);
    const brokkDir = join(testDir, ".brokk");
    const profilesDir = join(brokkDir, "profiles");
    await mkdir(profilesDir, { recursive: true });
    
    // Create profile.json with profiles map
    await writeFile(join(brokkDir, "profile.json"), JSON.stringify({
      name: "default",
      profiles: {
        "shared": { commands: { typecheck: "map version" } }
      }
    }));
    
    // Create directory profile with same name
    await writeFile(join(profilesDir, "shared.json"), JSON.stringify({
      name: "shared",
      commands: { typecheck: "directory version" }
    }));
    
    const profiles = await loadAllProfiles(testDir);
    assert.equal(profiles.shared.commands.typecheck, "directory version");
    
    await rm(testDir, { recursive: true, force: true });
  });
  
  it("returns empty map when no profiles exist", async () => {
    testDir = join(tmpdir(), `test-profiles-empty-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    
    const profiles = await loadAllProfiles(testDir);
    assert.deepStrictEqual(profiles, {});
    
    await rm(testDir, { recursive: true, force: true });
  });
});

describe("resolveVerifyCmd", () => {
  let testDir: string;
  
  it("resolves profile from card label", async () => {
    testDir = join(tmpdir(), `test-resolve-label-${Date.now()}`);
    const brokkDir = join(testDir, ".brokk", "profiles");
    await mkdir(brokkDir, { recursive: true });
    
    // Create test profile
    await writeFile(join(brokkDir, "ci.json"), JSON.stringify({
      name: "ci",
      commands: { typecheck: "tsc -b" }
    }));
    
    const result = await resolveVerifyCmd(testDir, "", {
      cardLabels: ["bug", "profile:ci"]
    });
    
    assert.equal(result.cmd, "tsc -b");
    assert.equal(result.source, "profile");
    assert.equal(result.profileName, "ci");
    
    await rm(testDir, { recursive: true, force: true });
  });
  
  it("fails loudly when card label selects missing profile", async () => {
    testDir = join(tmpdir(), `test-resolve-missing-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    
    await assert.rejects(
      resolveVerifyCmd(testDir, "", {
        cardLabels: ["profile:nonexistent"]
      }),
      /Profile "nonexistent" selected via card label but not found/
    );
    
    await rm(testDir, { recursive: true, force: true });
  });
  
  it("falls back to BROKK_VERIFY_PROFILE env var", async () => {
    testDir = join(tmpdir(), `test-resolve-env-${Date.now()}`);
    const brokkDir = join(testDir, ".brokk", "profiles");
    await mkdir(brokkDir, { recursive: true });
    
    // Create test profile
    await writeFile(join(brokkDir, "env-profile.json"), JSON.stringify({
      name: "env-profile",
      commands: { lint: "eslint ." }
    }));
    
    const result = await resolveVerifyCmd(testDir, "", {
      envProfileName: "env-profile"
    });
    
    assert.equal(result.cmd, "eslint .");
    assert.equal(result.source, "profile");
    assert.equal(result.profileName, "env-profile");
    
    await rm(testDir, { recursive: true, force: true });
  });
  
  it("falls back to default profile", async () => {
    testDir = join(tmpdir(), `test-resolve-default-${Date.now()}`);
    const brokkDir = join(testDir, ".brokk");
    await mkdir(brokkDir, { recursive: true });
    
    // Create profile.json with default profile
    await writeFile(join(brokkDir, "profile.json"), JSON.stringify({
      name: "default",
      commands: { typecheck: "pnpm typecheck" }
    }));
    
    const result = await resolveVerifyCmd(testDir, "");
    
    assert.equal(result.cmd, "pnpm typecheck");
    assert.equal(result.source, "profile");
    assert.equal(result.profileName, "default");
    
    await rm(testDir, { recursive: true, force: true });
  });
  
  it("falls back to BROKK_VERIFY_CMD env var", async () => {
    testDir = join(tmpdir(), `test-resolve-fallback-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    
    const result = await resolveVerifyCmd(testDir, "make test");
    
    assert.equal(result.cmd, "make test");
    assert.equal(result.source, "env");
    assert.equal(result.profileName, undefined);
    
    await rm(testDir, { recursive: true, force: true });
  });
  
  it("returns empty when no verify command found", async () => {
    testDir = join(tmpdir(), `test-resolve-none-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    
    const result = await resolveVerifyCmd(testDir, "");
    
    assert.equal(result.cmd, "");
    assert.equal(result.source, "none");
    assert.equal(result.profileName, undefined);
    
    await rm(testDir, { recursive: true, force: true });
  });
  
  it("card label has highest priority", async () => {
    testDir = join(tmpdir(), `test-resolve-priority-${Date.now()}`);
    const brokkDir = join(testDir, ".brokk", "profiles");
    await mkdir(brokkDir, { recursive: true });
    
    // Create multiple profiles
    await writeFile(join(brokkDir, "label-profile.json"), JSON.stringify({
      name: "label-profile",
      commands: { typecheck: "label version" }
    }));
    await writeFile(join(brokkDir, "env-profile.json"), JSON.stringify({
      name: "env-profile",
      commands: { typecheck: "env version" }
    }));
    await writeFile(join(brokkDir, "default.json"), JSON.stringify({
      name: "default",
      commands: { typecheck: "default version" }
    }));
    
    const result = await resolveVerifyCmd(testDir, "fallback version", {
      cardLabels: ["profile:label-profile"],
      envProfileName: "env-profile"
    });
    
    assert.equal(result.cmd, "label version");
    assert.equal(result.source, "profile");
    assert.equal(result.profileName, "label-profile");
    
    await rm(testDir, { recursive: true, force: true });
  });
});
