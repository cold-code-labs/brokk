// Validate profile — ADR 0074 Fase 4.
// Repo-local `.brokk/profile.json` overrides the worker's BROKK_VERIFY_CMD so
// each app carries its own typecheck/lint/test gate with the code.
// Named profiles: `.brokk/profiles/<name>.json` or a `profiles` map in profile.json.

import { readFile, readdir, stat } from "node:fs/promises";
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

/** A map of named profiles in profile.json */
export type ValidateProfilesMap = Record<string, ValidateProfile>;

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

/** Parse a single profile from JSON, returning null if invalid. */
function parseProfile(raw: string, name?: string): ValidateProfile | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ValidateProfile>;
    if (!parsed || typeof parsed !== "object") return null;
    const commands = parsed.commands ?? {};
    return {
      name: typeof parsed.name === "string" && parsed.name ? parsed.name : name ?? "default",
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

/** Load all named profiles from `.brokk/profiles/<name>.json` directory. */
async function loadProfilesFromDirectory(cwd: string): Promise<ValidateProfilesMap> {
  const profilesDir = join(cwd, ".brokk", "profiles");
  const profiles: ValidateProfilesMap = {};
  
  try {
    const entries = await readdir(profilesDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const name = entry.slice(0, -5); // Remove .json extension
      const filePath = join(profilesDir, entry);
      try {
        const raw = await readFile(filePath, "utf8");
        const profile = parseProfile(raw, name);
        if (profile) {
          profiles[name] = profile;
        }
      } catch {
        // Skip invalid profile files
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  
  return profiles;
}

/** Load all named profiles from a profiles map in profile.json. */
async function loadProfilesFromMap(cwd: string): Promise<ValidateProfilesMap> {
  const path = join(cwd, ".brokk", "profile.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    
    // Check if there's a profiles map
    if (!parsed.profiles || typeof parsed.profiles !== "object") return {};
    
    const profilesMap = parsed.profiles as Record<string, unknown>;
    const profiles: ValidateProfilesMap = {};
    
    for (const [name, value] of Object.entries(profilesMap)) {
      if (typeof value !== "object" || value === null) continue;
      const profileData = value as Partial<ValidateProfile>;
      const commands = profileData.commands ?? {};
      profiles[name] = {
        name,
        commands: {
          typecheck: typeof commands.typecheck === "string" ? commands.typecheck : undefined,
          lint: typeof commands.lint === "string" ? commands.lint : undefined,
          test: typeof commands.test === "string" ? commands.test : undefined,
          verify: Array.isArray(commands.verify)
            ? commands.verify.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
            : undefined,
        },
      };
    }
    
    return profiles;
  } catch {
    return {};
  }
}

/** Load all available profiles from a worktree. Checks both directory and map formats. */
export async function loadAllProfiles(cwd: string): Promise<ValidateProfilesMap> {
  // First try loading from directory
  const dirProfiles = await loadProfilesFromDirectory(cwd);
  
  // Then try loading from map in profile.json
  const mapProfiles = await loadProfilesFromMap(cwd);
  
  // Directory profiles take precedence over map profiles
  return { ...mapProfiles, ...dirProfiles };
}

/** Extract profile name from card labels (profile:<name>). */
export function extractProfileFromLabels(labels: string[]): string | null {
  for (const label of labels) {
    const match = label.match(/^profile:(.+)$/);
    if (match) {
      return match[1];
    }
  }
  return null;
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
 * Priority: card label → project default → env → file default → BROKK_VERIFY_CMD → "".
 * 
 * @param cwd - The worktree path
 * @param envFallback - The BROKK_VERIFY_CMD env var value
 * @param options - Optional profile selection context
 * @param options.cardLabels - Labels from the card (for profile:<name> extraction)
 * @param options.projectDefaultProfile - Project default profile name
 * @param options.envProfileName - BROKK_VERIFY_PROFILE env var value
 */
export async function resolveVerifyCmd(cwd: string, envFallback: string, options?: {
  cardLabels?: string[];
  projectDefaultProfile?: string;
  envProfileName?: string;
}): Promise<{
  cmd: string;
  source: "profile" | "env" | "none";
  profileName?: string;
}> {
  // Load all available profiles
  const allProfiles = await loadAllProfiles(cwd);
  
  // 1. Try card label first
  if (options?.cardLabels) {
    const labelProfileName = extractProfileFromLabels(options.cardLabels);
    if (labelProfileName) {
      const profile = allProfiles[labelProfileName];
      if (profile) {
        const cmd = profileVerifyCmd(profile);
        if (cmd) return { cmd, source: "profile", profileName: profile.name };
      } else {
        // Missing named profile fails loudly (not silent skip)
        throw new Error(`Profile "${labelProfileName}" selected via card label but not found in worktree`);
      }
    }
  }
  
  // 2. Try project default
  if (options?.projectDefaultProfile) {
    const profile = allProfiles[options.projectDefaultProfile];
    if (profile) {
      const cmd = profileVerifyCmd(profile);
      if (cmd) return { cmd, source: "profile", profileName: profile.name };
    }
    // If project default profile is specified but not found, continue to next priority
    // (don't fail loudly here as it might be a misconfiguration)
  }
  
  // 3. Try BROKK_VERIFY_PROFILE env var
  if (options?.envProfileName) {
    const profile = allProfiles[options.envProfileName];
    if (profile) {
      const cmd = profileVerifyCmd(profile);
      if (cmd) return { cmd, source: "profile", profileName: profile.name };
    }
    // If env profile is specified but not found, continue to next priority
    // (don't fail loudly here as it might be a misconfiguration)
  }
  
  // 4. Try default profile (from profile.json or profiles map)
  const defaultProfile = allProfiles["default"] ?? await loadValidateProfile(cwd);
  if (defaultProfile) {
    const cmd = profileVerifyCmd(defaultProfile);
    if (cmd) return { cmd, source: "profile", profileName: defaultProfile.name };
  }
  
  // 5. Try BROKK_VERIFY_CMD env var
  const env = envFallback.trim();
  if (env) return { cmd: env, source: "env" };
  
  // 6. No verify command
  return { cmd: "", source: "none" };
}
