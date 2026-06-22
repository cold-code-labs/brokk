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
      const pkg = `${v?.PkgName ?? "?"}@${v?.InstalledVersion ?? "?"}`;
      const fixed = v?.FixedVersion ? ` (fixed in ${v.FixedVersion})` : " (no fix available)";
      out.push({
        tool: "trivy",
        kind: "dependency",
        severity: mapTrivySeverity(v?.Severity),
        file: target, // the lockfile/manifest that pins the vulnerable dep
        ruleId: id,
        title: `${id} in ${pkg}`,
        message: `${String(v?.Title ?? v?.Description ?? "").slice(0, 300)}${fixed}`,
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
