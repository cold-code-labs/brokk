/**
 * The warm index builder (#4). After a forge, the runner generates a cheap,
 * bounded map of the repo from the worktree and ships it to the control plane,
 * keyed by repository. The PLANNER reads it (it has no checkout) so it picks
 * realistic keys/touches and decomposes against the real tree — not a guess.
 *
 * Deliberately cheap: tracked-file tree (via `git ls-files`) grouped by
 * directory + the workspace's package manifests. No parsing, no LLM, no deps.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const MAX_MAP_CHARS = 6_000;
const MAX_DIRS = 60;
const MAX_PKGS = 40;

/** Build the repo map from a worktree. Never throws — returns "" on any failure
 *  (a missing map just means the planner runs without it). */
export async function buildRepoMap(cwd: string): Promise<string> {
  let files: string[] = [];
  try {
    const { stdout } = await exec("git", ["ls-files"], { cwd, maxBuffer: 1024 * 1024 * 32 });
    files = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return "";
  }
  if (!files.length) return "";

  // Directory histogram (top-level + one nested level), most-populated first.
  const dirCounts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    const dir = parts.length === 1 ? "." : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }
  const dirs = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DIRS)
    .map(([dir, n]) => `- ${dir}/ (${n})`);

  // Package manifests — names + scripts give the planner the workspace shape.
  const pkgFiles = files.filter((f) => f === "package.json" || f.endsWith("/package.json")).slice(0, MAX_PKGS);
  const pkgs: string[] = [];
  for (const pf of pkgFiles) {
    try {
      const raw = await readFile(join(cwd, pf), "utf8");
      const json = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
      const name = json.name ?? pf.replace(/\/package\.json$/, "") ?? pf;
      const scripts = json.scripts ? Object.keys(json.scripts).slice(0, 8).join(", ") : "";
      pkgs.push(`- ${name} (${pf})${scripts ? ` — scripts: ${scripts}` : ""}`);
    } catch {
      // Skip unreadable/!JSON manifests.
    }
  }

  const out = [
    `# Repo map · ${files.length} tracked files`,
    "",
    "## Top directories (file count)",
    ...dirs,
  ];
  if (pkgs.length) {
    out.push("", "## Packages", ...pkgs);
  }
  const text = out.join("\n");
  return text.length > MAX_MAP_CHARS ? `${text.slice(0, MAX_MAP_CHARS)}\n…(truncated)` : text;
}
