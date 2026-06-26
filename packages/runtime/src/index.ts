/**
 * @brokk/runtime — Sleipnir's logic: the command allowlist (the trusted boundary
 * that replaces a human approval), `validateSpec`, the canonical fast-path, and
 * the resolver. Pure except for `buildDetectCtx` (which reads the checkout tree).
 * The supervisor consumes a `RuntimeSpec` and never knows the word "next".
 *
 * See docs/RUNTIME.md (the plan) and docs/runtime/SKILL.md (the Huginn faculty).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DetectCtx, RuntimeSpec } from "@brokk/core";
import { PACKAGE_MANAGERS, PM_ORDER, type PmId, PROVIDERS } from "./providers.js";

export type { DetectCtx, RuntimeSpec } from "@brokk/core";
export { PACKAGE_MANAGERS, PROVIDERS } from "./providers.js";

// ── The allowlist (the gate that replaces a human) ──────────────────────────────
//
// A command is allowed iff every `&&`-joined segment matches a CLOSED whitelist:
// it must start with a known package manager or framework binary and contain only
// whitelisted verbs, flags, $PORT/$HOST and the loopback host. Anything outside
// the set — `;`, pipes, `$(...)`, backticks, redirects, curl/wget/sudo/rm/ssh/eval,
// a bare `&` — fails to match and the spec is rejected. The set is the security
// model: an LLM-authored command can only ever be a benign framework invocation.

/** Tokens allowed AFTER the leading binary in a segment. */
const TOKEN = [
  "install",
  "exec",
  "run",
  "dev",
  "build",
  "start",
  "preview",
  "next",
  "vite",
  "astro",
  "node",
  "npx",
  "bunx",
  "-p",
  "-H",
  "\\$PORT",
  "\\$\\{PORT\\}",
  "\\$HOST",
  "\\$\\{HOST\\}",
  "0\\.0\\.0\\.0",
  "127\\.0\\.0\\.1",
  // long flags: --name or --name=value (value is a plain word, never shell syntax)
  "--[a-z][a-z-]*(=[\\w./@:-]+)?",
].join("|");

const LEAD = "(pnpm|npm|npx|yarn|bun|bunx|next|vite|astro|node)";
const SEGMENT_RE = new RegExp(`^${LEAD}(\\s+(${TOKEN}))*$`);

/** True iff `cmd` is a safe framework invocation per the closed allowlist. */
export function matchesAllowlist(cmd: string): boolean {
  if (!cmd || !cmd.trim()) return false;
  // `&&` is the ONLY connector. Split on it, then every segment must match the
  // whitelist — a stray single `&`, `;`, `|` etc. leaves a segment that can't.
  const segments = cmd.split("&&").map((s) => s.trim());
  if (segments.some((s) => s.length === 0)) return false; // empty (leading/trailing/`&`)
  return segments.every((s) => SEGMENT_RE.test(s));
}

// ── validateSpec — the one piece of trusted TS ──────────────────────────────────

/** Build a `supported:false` spec carrying a reason, preserving id/label/source. */
export function unsupported(reason: string, base?: Partial<RuntimeSpec>): RuntimeSpec {
  return {
    id: base?.id ?? "unknown",
    label: base?.label ?? "Unknown",
    appRoot: base?.appRoot ?? ".",
    install: base?.install ?? "",
    dev: base?.dev ?? "",
    build: base?.build,
    start: base?.start,
    health: base?.health,
    env: base?.env,
    evidence: base?.evidence,
    confidence: base?.confidence,
    supported: false,
    reason,
    source: base?.source ?? "ai",
  };
}

/** Audit a spec against the allowlist + the checkout. Returns the spec untouched
 *  when it passes; otherwise a `{ supported:false, reason }` variant. This is the
 *  boundary that lets us trust Huginn's decision without a human approval. */
export function validateSpec(spec: RuntimeSpec, ctx: DetectCtx): RuntimeSpec {
  if (!spec.supported) return spec; // already a clean unsupported — nothing to boot

  const commands = [spec.install, spec.dev, spec.build, spec.start].filter(
    (c): c is string => Boolean(c && c.trim()),
  );
  const bad = commands.find((cmd) => !matchesAllowlist(cmd));
  if (bad) return unsupported(`command rejected by allowlist: ${bad}`, spec);

  // A bootable spec must bind the assigned port, or the gateway can't reach it.
  if (!/\$PORT|\$\{PORT\}/.test(spec.dev) && !/\$PORT|\$\{PORT\}/.test(spec.start ?? "")) {
    return unsupported("no $PORT in the run command", spec);
  }

  // The appRoot must exist and carry a manifest (no manifest → nothing to install).
  const appRoot = spec.appRoot || ".";
  if (appRoot.includes("..")) return unsupported(`appRoot escapes the checkout: ${appRoot}`, spec);
  if (!ctx.read(join(appRoot, "package.json"))) {
    return unsupported(`no package.json at ${appRoot}`, spec);
  }
  return spec;
}

// ── DetectCtx — the read-only view of a checkout ────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  "coverage",
  ".turbo",
  ".cache",
]);

/** Walk `dir` to `depth` levels, returning checkout-relative file/dir paths
 *  (dirs end with `/`). Heavy/generated dirs are pruned. Best-effort — an
 *  unreadable subtree is skipped, never thrown. */
function walk(dir: string, depth: number): string[] {
  const out: string[] = [];
  const recurse = (abs: string, left: number): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".git") || SKIP_DIRS.has(e.name)) continue;
      const absChild = join(abs, e.name);
      const rel = relative(dir, absChild).split(sep).join("/");
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        if (left > 1) recurse(absChild, left - 1);
      } else {
        out.push(rel);
      }
    }
  };
  recurse(dir, depth);
  return out;
}

/** Build the read-only context the resolver + Huginn skill reason over. */
export function buildDetectCtx(dir: string): DetectCtx {
  const files = walk(dir, 2);
  let pkg: Record<string, unknown> | undefined;
  const read = (rel: string): string | null => {
    try {
      const abs = join(dir, rel);
      // Defensive: never read outside the checkout via a `..` in `rel`.
      if (!abs.startsWith(dir) || !existsSync(abs) || statSync(abs).isDirectory()) return null;
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };
  const pkgRaw = read("package.json");
  if (pkgRaw) {
    try {
      pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    } catch {
      pkg = undefined;
    }
  }
  return { dir, files, pkg, read };
}

// ── The fast-path — a canonical match emits the preset, no LLM pass ─────────────

/** All declared dependency names from a package.json (deps + devDeps + peer). */
function depNames(pkg: Record<string, unknown> | undefined): Set<string> {
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const obj = pkg?.[key];
    if (obj && typeof obj === "object") for (const k of Object.keys(obj)) names.add(k);
  }
  return names;
}

/** Detect the package manager from the lockfile present at the checkout root. */
export function detectPm(ctx: DetectCtx): PmId {
  for (const id of PM_ORDER) {
    if (ctx.read(PACKAGE_MANAGERS[id].lockfile)) return id;
  }
  return "pnpm"; // fleet default
}

/** The cheap, deterministic path for a canonical single-app repo: package.json at
 *  root with a first-class framework dep + config/script. Emits the preset spec
 *  (`source:"preset"`) so the obvious case never burns an LLM call. Null when the
 *  repo isn't an unambiguous root match — the resolver then falls to Huginn. */
export function fastPath(ctx: DetectCtx): RuntimeSpec | null {
  if (!ctx.pkg) return null;
  const deps = depNames(ctx.pkg);
  const scripts = (ctx.pkg.scripts ?? {}) as Record<string, string>;

  for (const p of PROVIDERS) {
    if (!p.supported || !p.commands) continue;
    const evidence: string[] = [];
    if (p.detect.anyDep?.some((d) => deps.has(d))) {
      evidence.push(...p.detect.anyDep.filter((d) => deps.has(d)).map((d) => `package.json#${d}`));
    }
    const cfg = p.detect.anyFile?.find((f) => ctx.read(f));
    if (cfg) evidence.push(cfg);
    const scriptRe = p.detect.anyScriptMatches ? new RegExp(p.detect.anyScriptMatches) : null;
    const hasScript = scriptRe ? Object.values(scripts).some((s) => scriptRe.test(s)) : false;
    if (hasScript) evidence.push("package.json#scripts");

    // Canonical = the framework dep AND (a config file OR a matching script).
    const hasDep = p.detect.anyDep?.some((d) => deps.has(d)) ?? false;
    if (!hasDep || (!cfg && !hasScript)) continue;

    const pm = detectPm(ctx);
    const info = PACKAGE_MANAGERS[pm];
    const fill = (tpl: string) => tpl.replace(/\{exec\}/g, info.exec);
    return {
      id: p.id,
      label: p.label,
      appRoot: ".",
      install: info.install,
      dev: fill(p.commands.dev),
      build: fill(p.commands.build),
      start: fill(p.commands.start),
      health: p.health ?? "/",
      supported: true,
      evidence,
      confidence: 1,
      source: "preset",
    };
  }
  return null;
}

// ── The resolver ────────────────────────────────────────────────────────────────

/** Resolve how to run a checkout. Precedence (decided once at connect, reused per
 *  boot): pinned spec → canonical fast-path → Huginn skill (`detect`) → a clean
 *  `unsupported`. Pure: the caller persists the result (pins `project.runtime`);
 *  `detect` is injected so this package never depends on the LLM/scout. */
export async function resolveRuntime(
  pinned: RuntimeSpec | null | undefined,
  ctx: DetectCtx,
  detect?: (ctx: DetectCtx) => Promise<RuntimeSpec>,
): Promise<RuntimeSpec> {
  if (pinned) return pinned; // 1 reuse the decision (supported OR unsupported)
  const fast = fastPath(ctx); // 2 canonical preset, no LLM
  if (fast) return fast;
  if (detect) return validateSpec(await detect(ctx), ctx); // 3 AI faculty + audit
  return unsupported("no supported runtime detected (and no detector available)");
}

/** Compose the shell command for a boot mode from a (supported) spec. `dev` runs
 *  install + the HMR server; `build` runs build + serve (parity with the legacy
 *  previewCmd/previewDevCmd). Prefixes a `cd <appRoot>` when the app isn't at root.
 *  $PORT is expanded by the supervisor. */
export function composeCommand(spec: RuntimeSpec, mode: "dev" | "build"): string {
  const run =
    mode === "dev"
      ? [spec.install, spec.dev].filter(Boolean).join(" && ")
      : [spec.build, spec.start].filter(Boolean).join(" && ");
  const root = spec.appRoot && spec.appRoot !== "." ? `cd ${spec.appRoot} && ` : "";
  return `${root}${run}`;
}
