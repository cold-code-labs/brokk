/**
 * Eitri's security ward — a deterministic vulnerability scan that runs OSS
 * scanners over the PR's worktree BEFORE the LLM review, scopes the findings to
 * the files the PR actually changed, and feeds them back into the verdict.
 *
 * Two scanners, both single-binary with JSON output:
 *   - semgrep (SAST)   — code-level vulnerabilities, secrets-in-code, injections.
 *   - trivy   (fs)     — dependency CVEs (lockfiles) + filesystem secrets.
 *
 * Both are optional: if a binary is absent the scan degrades gracefully (the
 * tool is reported as "skipped" and the review still runs). Findings are scoped
 * to changed files so Eitri only reacts to what the PR introduced — a pre-existing
 * CVE in an untouched dependency does not block an unrelated change.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 1024 * 1024 * 128; // 128MB — scanner JSON can be large

export type Severity = "critical" | "high" | "medium" | "low" | "info";
const SEV_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const SEV_EMOJI: Record<Severity, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "⚪" };

export interface Finding {
  tool: "semgrep" | "trivy";
  kind: "sast" | "dependency" | "secret";
  severity: Severity;
  file: string; // repo-relative path
  line?: number;
  ruleId: string; // rule id / CVE id
  title: string;
  message: string;
  // Dependency findings only — the package + the version to bump to. Lets Eitri
  // hand Brokk a concrete, machine-actionable bump plan instead of prose.
  pkgName?: string;
  installedVersion?: string;
  fixedVersion?: string; // smallest safe upgrade in the installed major, if any
}

export interface ScanResult {
  findings: Finding[]; // scoped to changed files
  blocking: Finding[]; // findings at/above the block threshold
  toolsRun: string[];
  toolsSkipped: string[]; // binary not installed
  errors: string[]; // tool present but failed
  scanned: boolean; // false when scanning is disabled
}

export interface ScanConfig {
  enabled: boolean;
  semgrepConfig: string; // e.g. "auto" or "p/security-audit"
  blockSeverity: Severity; // minimum severity that forces REQUEST_CHANGES
}

const EMPTY: ScanResult = {
  findings: [],
  blocking: [],
  toolsRun: [],
  toolsSkipped: [],
  errors: [],
  scanned: false,
};

/** Normalize a path the way `git`/scanners emit it (posix, no leading ./). */
function norm(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/").trim();
}

async function has(bin: string): Promise<boolean> {
  try {
    await exec(bin, ["--version"], { maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/** Run the scanners, scope findings to `changedFiles`, and classify blockers. */
export async function runScan(opts: {
  cwd: string;
  changedFiles: string[];
  config: ScanConfig;
}): Promise<ScanResult> {
  if (!opts.config.enabled) return EMPTY;

  const changed = new Set(opts.changedFiles.map(norm));
  const inScope = (f: string) => changed.has(norm(f));

  const toolsRun: string[] = [];
  const toolsSkipped: string[] = [];
  const errors: string[] = [];
  const findings: Finding[] = [];

  // --- semgrep (SAST), scanned over the changed files only -------------------
  if (await has("semgrep")) {
    toolsRun.push("semgrep");
    try {
      findings.push(...(await runSemgrep(opts.cwd, opts.changedFiles, opts.config.semgrepConfig)));
    } catch (e) {
      errors.push(`semgrep: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  } else {
    toolsSkipped.push("semgrep");
  }

  // --- trivy (deps + secrets), scanned over the tree, filtered to scope ------
  if (await has("trivy")) {
    toolsRun.push("trivy");
    try {
      findings.push(...(await runTrivy(opts.cwd)));
    } catch (e) {
      errors.push(`trivy: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  } else {
    toolsSkipped.push("trivy");
  }

  const scoped = dedupe(findings.filter((f) => inScope(f.file)));
  const threshold = SEV_RANK[opts.config.blockSeverity];
  const blocking = scoped.filter((f) => SEV_RANK[f.severity] >= threshold);

  return { findings: scoped, blocking, toolsRun, toolsSkipped, errors, scanned: true };
}

// --- semgrep ----------------------------------------------------------------

function mapSemgrepSeverity(r: any): Severity {
  const meta = String(r?.extra?.metadata?.impact ?? r?.extra?.metadata?.severity ?? "").toUpperCase();
  if (meta === "CRITICAL") return "critical";
  if (meta === "HIGH") return "high";
  if (meta === "MEDIUM") return "medium";
  if (meta === "LOW") return "low";
  // Fall back to the rule's own severity.
  const sev = String(r?.extra?.severity ?? "").toUpperCase();
  if (sev === "ERROR") return "high";
  if (sev === "WARNING") return "medium";
  return "low";
}

async function runSemgrep(cwd: string, changedFiles: string[], config: string): Promise<Finding[]> {
  // Only scan files that still exist in the worktree; bound runtime by targeting
  // the diff rather than the whole repo. Nothing to scan → no findings.
  const targets = changedFiles.map(norm).filter(Boolean);
  if (targets.length === 0) return [];

  const args = [
    "scan",
    `--config=${config}`,
    "--json",
    "--quiet",
    // semgrep's `auto` config refuses to run with metrics off (it picks rules via
    // the registry/telemetry); pinned packs (p/…) run fine with metrics disabled.
    ...(config === "auto" ? [] : ["--metrics=off"]),
    "--timeout=120",
    "--disable-version-check",
    ...targets,
  ];
  let stdout = "";
  try {
    ({ stdout } = await exec("semgrep", args, { cwd, maxBuffer: MAX_BUFFER }));
  } catch (e: any) {
    // semgrep exits non-zero on internal errors but still emits JSON for some;
    // only a missing/empty stdout is a real failure.
    stdout = e?.stdout ?? "";
    if (!stdout) throw e;
  }
  const parsed = JSON.parse(stdout || "{}");
  const results: any[] = Array.isArray(parsed?.results) ? parsed.results : [];
  return results.map((r) => {
    const ruleId = String(r?.check_id ?? "semgrep.rule");
    return {
      tool: "semgrep" as const,
      kind: "sast" as const,
      severity: mapSemgrepSeverity(r),
      file: norm(String(r?.path ?? "")),
      line: Number(r?.start?.line) || undefined,
      ruleId,
      title: ruleId.split(".").pop() ?? ruleId,
      message: String(r?.extra?.message ?? "").slice(0, 400),
    };
  });
}

// --- trivy ------------------------------------------------------------------

function mapTrivySeverity(s: string): Severity {
  switch (String(s).toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      return "info";
  }
}

async function runTrivy(cwd: string): Promise<Finding[]> {
  const args = [
    "fs",
    "--quiet",
    "--scanners=vuln,secret",
    "--format=json",
    "--timeout=5m",
    "--no-progress",
    ".",
  ];
  let stdout = "";
  try {
    ({ stdout } = await exec("trivy", args, { cwd, maxBuffer: MAX_BUFFER }));
  } catch (e: any) {
    stdout = e?.stdout ?? "";
    if (!stdout) throw e;
  }
  const parsed = JSON.parse(stdout || "{}");
  const results: any[] = Array.isArray(parsed?.Results) ? parsed.Results : [];
  const out: Finding[] = [];
  for (const res of results) {
    const target = norm(String(res?.Target ?? ""));
    for (const v of res?.Vulnerabilities ?? []) {
      const id = String(v?.VulnerabilityID ?? "CVE");
      const pkgName = v?.PkgName ? String(v.PkgName) : undefined;
      const installedVersion = v?.InstalledVersion ? String(v.InstalledVersion) : undefined;
      const pkg = `${pkgName ?? "?"}@${installedVersion ?? "?"}`;
      const fixedVersion = pickFixedVersion(installedVersion, v?.FixedVersion);
      const fixed = v?.FixedVersion ? ` (fixed in ${v.FixedVersion})` : " (no fix available)";
      out.push({
        tool: "trivy",
        kind: "dependency",
        severity: mapTrivySeverity(v?.Severity),
        file: target, // the lockfile/manifest that pins the vulnerable dep
        ruleId: id,
        title: `${id} in ${pkg}`,
        message: `${String(v?.Title ?? v?.Description ?? "").slice(0, 300)}${fixed}`,
        pkgName,
        installedVersion,
        fixedVersion,
      });
    }
    for (const s of res?.Secrets ?? []) {
      out.push({
        tool: "trivy",
        kind: "secret",
        severity: mapTrivySeverity(s?.Severity) === "info" ? "high" : mapTrivySeverity(s?.Severity),
        file: target,
        line: Number(s?.StartLine) || undefined,
        ruleId: String(s?.RuleID ?? "secret"),
        title: `Exposed secret: ${s?.Title ?? s?.RuleID ?? "match"}`,
        message: "A hardcoded secret/credential was detected in a changed file.",
      });
    }
  }
  return out;
}

/** Parse a dotted version into numeric segments (non-numeric tails dropped). */
function parseVer(v: string): number[] {
  return v
    .trim()
    .replace(/^[vV=]/, "")
    .split(".")
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

function cmpVer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Trivy's FixedVersion is often a comma list spanning majors (e.g. next:
 * "15.5.21, 16.2.11"). Pick the *smallest* fix that is an upgrade from what's
 * installed and stays in the installed major — the least-disruptive safe bump.
 * Falls back to the overall smallest upgrade, then the raw first token.
 */
export function pickFixedVersion(installed?: string, fixedRaw?: unknown): string | undefined {
  const raw = typeof fixedRaw === "string" ? fixedRaw : "";
  const cands = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (cands.length === 0) return undefined;
  if (!installed) return cands[0];
  const inst = parseVer(installed);
  const upgrades = cands
    .map((c) => ({ c, v: parseVer(c) }))
    .filter((x) => x.v.length > 0 && cmpVer(x.v, inst) > 0)
    .sort((a, b) => cmpVer(a.v, b.v));
  if (upgrades.length === 0) return cands[cands.length - 1];
  const sameMajor = upgrades.find((x) => x.v[0] === inst[0]);
  return (sameMajor ?? upgrades[0]).c;
}

export interface Bump {
  pkg: string;
  from?: string;
  to: string;
}

/**
 * Collapse the blocking dependency findings into one bump per package (highest
 * target wins), so Eitri can hand Brokk an exact, deduped upgrade list. Only
 * packages with a known fix are actionable; the rest are surfaced separately.
 */
export function buildBumpPlan(r: ScanResult): Bump[] {
  const byPkg = new Map<string, Bump>();
  for (const f of r.blocking) {
    if (f.kind !== "dependency" || !f.pkgName || !f.fixedVersion) continue;
    const prev = byPkg.get(f.pkgName);
    if (!prev || cmpVer(parseVer(f.fixedVersion), parseVer(prev.to)) > 0) {
      byPkg.set(f.pkgName, { pkg: f.pkgName, from: f.installedVersion, to: f.fixedVersion });
    }
  }
  return [...byPkg.values()].sort((a, b) => a.pkg.localeCompare(b.pkg));
}

/** Which lockfile the dependency findings live in → which package manager. */
function detectPackageManager(r: ScanResult): "pnpm" | "npm" | "yarn" {
  const files = r.blocking.filter((f) => f.kind === "dependency").map((f) => f.file);
  if (files.some((f) => /package-lock\.json$/.test(f))) return "npm";
  if (files.some((f) => /yarn\.lock$/.test(f))) return "yarn";
  return "pnpm"; // CCL fleet default (pnpm-lock.yaml)
}

/**
 * The imperative remediation Eitri appends when the security ward blocks on
 * dependency CVEs. It must be *executable*, not aspirational: most of these are
 * TRANSITIVE deps, so editing `dependencies` does nothing — the only reliable
 * fix is a resolutions/overrides pin + a lockfile regen. We hand Brokk the exact
 * override block and commands so the revise round is deterministic, not a guess.
 */
export function formatBumpRemediation(r: ScanResult): string {
  const bumps = buildBumpPlan(r);
  if (bumps.length === 0) return "";
  const pm = detectPackageManager(r);
  const rows = bumps
    .map((b) => `- \`${b.pkg}\`${b.from ? ` ${b.from}` : ""} → \`>=${b.to}\``)
    .join("\n");
  const pinPairs = bumps.map((b) => `"${b.pkg}": ">=${b.to}"`).join(", ");
  const overridesBlock =
    pm === "yarn"
      ? `"resolutions": { ${pinPairs} }`
      : pm === "npm"
        ? `"overrides": { ${pinPairs} }`
        : `"pnpm": { "overrides": { ${pinPairs} } }`;
  const installCmd =
    pm === "yarn" ? "yarn install" : pm === "npm" ? "npm install" : "pnpm install --no-frozen-lockfile";
  const lockfile =
    pm === "yarn" ? "yarn.lock" : pm === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
  return [
    "## 🔧 Required dependency bumps (deterministic — do exactly this)",
    "These blocking findings are PRE-EXISTING CVEs in dependencies (in the lockfile),",
    "not in your diff. Most are **transitive**, so editing `dependencies` will NOT fix",
    `them — you MUST pin them via ${pm} ${pm === "yarn" ? "resolutions" : "overrides"} and`,
    "regenerate the lockfile. Steps:",
    "",
    `1. In \`package.json\`, add/merge: \`${overridesBlock}\``,
    pm === "pnpm"
      ? "2. If `pnpm-workspace.yaml` exists and is malformed (e.g. an `allowBuilds:` key, or no `packages:` list), FIX it: it needs a `packages:` list (use `- '.'` for a single-package repo) and build approvals go under `onlyBuiltDependencies:`. A broken workspace file makes `pnpm install` fail silently."
      : "2. (skip)",
    `3. Run \`${installCmd}\` to regenerate \`${lockfile}\`.`,
    `4. Commit BOTH \`package.json\` and \`${lockfile}\` to the same branch. Change no application code; open no new PR.`,
    "",
    "Target versions:",
    rows,
  ]
    .filter((l) => l !== "2. (skip)")
    .join("\n");
}

// --- shaping ----------------------------------------------------------------

function dedupe(fs: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of fs.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])) {
    const key = `${f.tool}|${f.ruleId}|${f.file}|${f.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function line(f: Finding): string {
  const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "_(repo)_";
  return `- ${SEV_EMOJI[f.severity]} **${f.severity.toUpperCase()}** [${f.tool}] ${loc} — ${f.title}. ${f.message}`;
}

/** The markdown section Eitri prepends to its PR review comment. */
export function formatScanMarkdown(r: ScanResult): string {
  if (!r.scanned) return "";
  if (r.toolsRun.length === 0) {
    return (
      "## 🔒 Security scan\n" +
      "_Skipped — no scanners installed on the Eitri host (semgrep, trivy)._"
    );
  }

  const head =
    `## 🔒 Security scan\n` +
    `Ran **${r.toolsRun.join(", ")}**` +
    (r.toolsSkipped.length ? ` · skipped ${r.toolsSkipped.join(", ")} (not installed)` : "") +
    ` · scoped to changed files · **${r.blocking.length} blocking**, ${r.findings.length} total.`;

  if (r.findings.length === 0) {
    return `${head}\n\nNo security findings in the changed files. ✅` + errLine(r);
  }

  const blockers = r.blocking;
  const others = r.findings.filter((f) => !blockers.includes(f));
  const parts = [head];
  if (blockers.length) parts.push("\n**Blocking — must fix:**\n" + blockers.map(line).join("\n"));
  if (others.length) parts.push("\n**Other findings:**\n" + others.map(line).join("\n"));
  return parts.join("\n") + errLine(r);
}

function errLine(r: ScanResult): string {
  return r.errors.length ? `\n\n> ⚠️ scanner errors: ${r.errors.join("; ")}` : "";
}

/** A compact block injected into the reviewer prompt so the LLM weighs the scan. */
export function scanPromptBlock(r: ScanResult): string {
  if (!r.scanned || r.toolsRun.length === 0) return "";
  if (r.findings.length === 0) {
    return "A static security scan (semgrep, trivy) ran on the changed files and found nothing.";
  }
  const lines = r.findings
    .map((f) => `- [${f.severity.toUpperCase()}] ${f.tool} ${f.file}${f.line ? `:${f.line}` : ""} — ${f.title}: ${f.message}`)
    .join("\n");
  return [
    "A static security scan ran on the changed files. Findings below.",
    "HIGH/CRITICAL findings AUTOMATICALLY force REQUEST_CHANGES (Eitri's security ward gates",
    "this independently of your verdict). In your review, confirm each blocking finding and",
    "tell the author concretely how to fix it — or, if one is a clear false positive, say so",
    "and explain why so a human can override.",
    "",
    lines,
  ].join("\n");
}
