// Validate profile — ADR 0074 Fase 4.
// Repo-local `.brokk/profile.json` overrides the worker's BROKK_VERIFY_CMD so
// each app carries its own typecheck/lint/test gate with the code.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ValidateProfile = {
  name: string;
  commands: {
    typecheck?: string;
    lint?: string;
    test?: string;
    /** Optional free-form ordered list; wins over named keys when present. */
    verify?: string[];
  };
};

const ORDER = ["typecheck", "lint", "test"] as const;

/** Load `.brokk/profile.json` from a worktree. Returns null when missing/invalid. */
export async function loadValidateProfile(cwd: string): Promise<ValidateProfile | null> {
  const path = join(cwd, ".brokk", "profile.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ValidateProfile>;
    if (!parsed || typeof parsed !== "object") return null;
    const commands = parsed.commands ?? {};
    return {
      name: typeof parsed.name === "string" && parsed.name ? parsed.name : "default",
      commands: {
        typecheck: typeof commands.typecheck === "string" ? commands.typecheck : undefined,
        lint: typeof commands.lint === "string" ? commands.lint : undefined,
        test: typeof commands.test === "string" ? commands.test : undefined,
        verify: Array.isArray(commands.verify)
          ? commands.verify.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
          : undefined,
      },
    };
  } catch {
    return null;
  }
}

/** Join profile commands into a single shell pipeline for `runVerify`. */
export function profileVerifyCmd(profile: ValidateProfile): string {
  if (profile.commands.verify?.length) {
    return profile.commands.verify.join(" && ");
  }
  const parts: string[] = [];
  for (const key of ORDER) {
    const cmd = profile.commands[key];
    if (cmd?.trim()) parts.push(cmd.trim());
  }
  return parts.join(" && ");
}

/**
 * Resolve the effective verify command for a worktree.
 * Priority: `.brokk/profile.json` → env fallback (`BROKK_VERIFY_CMD`) → "".
 */
export async function resolveVerifyCmd(cwd: string, envFallback: string): Promise<{
  cmd: string;
  source: "profile" | "env" | "none";
  profileName?: string;
}> {
  const profile = await loadValidateProfile(cwd);
  if (profile) {
    const cmd = profileVerifyCmd(profile);
    if (cmd) return { cmd, source: "profile", profileName: profile.name };
  }
  const env = envFallback.trim();
  if (env) return { cmd: env, source: "env" };
  return { cmd: "", source: "none" };
}
