/**
 * @brokk/core/runtime — Sleipnir's logic: the command allowlist (the trusted boundary
 * that replaces a human approval), `validateSpec`, the canonical fast-path, the
 * resolver, and preview densification (BROKK-37: Next webpack over Turbopack).
 * Pure except for `buildDetectCtx` (which reads the checkout tree). The supervisor
 * consumes a `RuntimeSpec` and never knows the word "next" at spawn time — densify
 * rewrites the command here before the spec is composed.
 *
 * See docs/RUNTIME.md (the plan) and docs/runtime/SKILL.md (the Huginn faculty).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DetectCtx, RuntimeSpec } from "../index.js";
import { PACKAGE_MANAGERS, PM_ORDER, type PmId, PROVIDERS } from "./providers.js";

export type { DetectCtx, RuntimeSpec } from "../index.js";
export { PACKAGE_MANAGERS, PROVIDERS, PM_ORDER } from "./providers.js";
export type { PmId } from "./providers.js";

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
  "expo",
  "export",
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

/** Workspace member directories declared by the checkout, checkout-relative and
 *  without a trailing slash. Reads pnpm-workspace.yaml `packages:` and npm/yarn
 *  `workspaces`. Globs are expanded against the walk, so only directories that
 *  actually exist come back; `**` is deliberately NOT supported (the fleet
 *  declares explicit globs, and an unbounded match would make the ambiguity
 *  check below meaningless). */
export function workspaceDirs(ctx: DetectCtx): string[] {
  const patterns: string[] = [];

  // pnpm: a `packages:` block of `- <glob>` entries. Parsed line-wise rather
  // than with a YAML dep — this is the only shape the fleet emits, and the
  // resolver must stay dependency-free.
  const ws = ctx.read("pnpm-workspace.yaml");
  if (ws) {
    let inPackages = false;
    for (const raw of ws.split("\n")) {
      const line = raw.replace(/#.*$/, "").trimEnd();
      if (!line.trim()) continue;
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      // Any other top-level key ends the block (e.g. `allowBuilds:`).
      if (!/^\s/.test(line)) inPackages = false;
      if (!inPackages) continue;
      const m = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
      if (m?.[1]) patterns.push(m[1]);
    }
  }

  // npm/yarn: `workspaces` as an array, or `{ packages: [...] }`.
  const wsField = ctx.pkg?.workspaces;
  const fromPkg = Array.isArray(wsField)
    ? wsField
    : ((wsField as { packages?: unknown } | undefined)?.packages ?? null);
  if (Array.isArray(fromPkg)) {
    for (const p of fromPkg) if (typeof p === "string") patterns.push(p);
  }

  const dirs = new Set(
    ctx.files.filter((f) => f.endsWith("/")).map((f) => f.slice(0, -1)),
  );
  const out = new Set<string>();
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/+$/, "");
    if (clean.includes("**") || clean.includes("..")) continue;
    if (!clean.includes("*")) {
      if (dirs.has(clean)) out.add(clean);
      continue;
    }
    // Single-segment `*` only: `packages/*` matches `packages/client`, and must
    // not leak into `packages/client/src`.
    const re = new RegExp(`^${clean.split("*").map(escapeRe).join("[^/]+")}$`);
    for (const d of dirs) if (re.test(d)) out.add(d);
  }
  return [...out].sort();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match the providers against ONE candidate root. `root` is checkout-relative
 *  ("." for the repo root); reads and evidence are resolved beneath it. */
function matchProviderAt(ctx: DetectCtx, root: string): RuntimeSpec | null {
  const at = (rel: string) => (root === "." ? rel : `${root}/${rel}`);
  const pkg =
    root === "."
      ? ctx.pkg
      : (() => {
          const raw = ctx.read(at("package.json"));
          if (!raw) return undefined;
          try {
            return JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })();
  if (!pkg) return null;

  const deps = depNames(pkg);
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;

  for (const p of PROVIDERS) {
    if (!p.supported || !p.commands) continue;
    const evidence: string[] = [];
    if (p.detect.anyDep?.some((d) => deps.has(d))) {
      evidence.push(
        ...p.detect.anyDep.filter((d) => deps.has(d)).map((d) => `${at("package.json")}#${d}`),
      );
    }
    const cfg = p.detect.anyFile?.find((f) => ctx.read(at(f)));
    if (cfg) evidence.push(at(cfg));
    const scriptRe = p.detect.anyScriptMatches ? new RegExp(p.detect.anyScriptMatches) : null;
    const hasScript = scriptRe ? Object.values(scripts).some((s) => scriptRe.test(s)) : false;
    if (hasScript) evidence.push(`${at("package.json")}#scripts`);

    // Canonical = the framework dep AND (a config file OR a matching script).
    const hasDep = p.detect.anyDep?.some((d) => deps.has(d)) ?? false;
    if (!hasDep || (!cfg && !hasScript)) continue;

    // The package manager is always read from the CHECKOUT root: in a workspace
    // the root lockfile is what `install` acts on, and a member may carry none.
    const pm = detectPm(ctx);
    const info = PACKAGE_MANAGERS[pm];
    const fill = (tpl: string) => tpl.replace(/\{exec\}/g, info.exec);
    return {
      id: p.id,
      label: p.label,
      appRoot: root,
      install: info.install,
      dev: fill(p.commands.dev),
      build: fill(p.commands.build),
      start: fill(p.commands.start),
      health: p.health ?? "/",
      bundleProbe: p.bundleProbe,
      env: p.env,
      prepareFiles: p.prepareFiles,
      supported: true,
      evidence,
      confidence: 1,
      source: "preset",
    };
  }
  return null;
}

/** The cheap, deterministic path for a canonical app: package.json with a
 *  first-class framework dep + config/script. Tries the repo root first, then —
 *  when the root carries no app, which is the normal shape of a monorepo whose
 *  root package.json only aggregates — the declared workspace members. Emits the
 *  preset spec (`source:"preset"`) so the obvious case never burns an LLM call.
 *
 *  A workspace hit only counts when it is UNAMBIGUOUS: exactly one member
 *  matches. Two apps in one repo is a real choice (which one is "the" preview?)
 *  and belongs to Huginn, not to a coin flip here. Null when nothing canonical
 *  is found — the resolver then falls to Huginn. */
export function fastPath(ctx: DetectCtx): RuntimeSpec | null {
  const atRoot = matchProviderAt(ctx, ".");
  if (atRoot) return atRoot;

  const members = workspaceDirs(ctx);
  if (members.length === 0) return null;

  const hits = members
    .map((dir) => matchProviderAt(ctx, dir))
    .filter((s): s is RuntimeSpec => s !== null);
  return hits.length === 1 ? hits[0]! : null;
}

// ── Preview densification (BROKK-37) ────────────────────────────────────────────
//
// Next.js 16+ defaults `next dev` to Turbopack (~4GB RSS/app) — inviável when the
// forge hosts many concurrent previews. Webpack/SWC sits ~1–1.5GB. Next 15 already
// defaults to webpack; `--webpack` is unknown there and would crash the boot.
// Applied on every resolve (including pinned specs) so a fleet upgrade to Next 16
// does not silently re-introduce the Turbopack tax.

/** First major digit of a `next` version range (`^16.2.0` → 16). Null when absent
 *  or unparseable (`catalog:`, `workspace:*`, …). */
export function parseNextMajor(pkg: Record<string, unknown> | undefined): number | null {
  if (!pkg) return null;
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const obj = pkg[key];
    if (!obj || typeof obj !== "object") continue;
    const ver = (obj as Record<string, unknown>).next;
    if (typeof ver !== "string") continue;
    const m = ver.match(/(?:^|[^\d])(\d+)\./);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Read the appRoot package.json via DetectCtx (root or nested). */
function pkgAtAppRoot(ctx: DetectCtx, appRoot: string): Record<string, unknown> | undefined {
  const rel = !appRoot || appRoot === "." ? "package.json" : `${appRoot.replace(/\/$/, "")}/package.json`;
  if (rel === "package.json" && ctx.pkg) return ctx.pkg;
  const raw = ctx.read(rel);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Strip Turbopack flags from a `next dev` command; on Next ≥16 inject `--webpack`
 *  so the preview stays on webpack/SWC. No-op for non-Next or unsupported specs. */
export function densifyNextPreview(spec: RuntimeSpec, ctx: DetectCtx): RuntimeSpec {
  if (!spec.supported || !spec.dev || !/\bnext\s+dev\b/.test(spec.dev)) return spec;

  let dev = spec.dev
    // Drop any explicit Turbopack opt-in (Next 15 scripts often ship `--turbo`).
    .replace(/(^|\s)--turbo(?:pack)?(?=\s|$)/g, "$1")
    // Idempotent: strip a prior --webpack before re-injecting for Next ≥16.
    .replace(/(^|\s)--webpack(?=\s|$)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  const major = parseNextMajor(pkgAtAppRoot(ctx, spec.appRoot ?? "."));
  // Next 16+ Turbopack is the default — force webpack. Next ≤15 already uses
  // webpack; passing --webpack there is `error: unknown option` and kills boot.
  if (major !== null && major >= 16) {
    dev = dev.replace(/\bnext\s+dev\b/, "next dev --webpack");
  }

  return dev === spec.dev ? spec : { ...spec, dev };
}

// ── The resolver ────────────────────────────────────────────────────────────────

/** Resolve how to run a checkout. Precedence (decided once at connect, reused per
 *  boot): pinned spec → canonical fast-path → Huginn skill (`detect`) → a clean
 *  `unsupported`. Pure: the caller persists the result (pins `project.runtime`);
 *  `detect` is injected so this package never depends on the LLM/scout.
 *  Always runs densifyNextPreview so pinned Next 16 specs pick up `--webpack`. */
export async function resolveRuntime(
  pinned: RuntimeSpec | null | undefined,
  ctx: DetectCtx,
  detect?: (ctx: DetectCtx) => Promise<RuntimeSpec>,
): Promise<RuntimeSpec> {
  let spec: RuntimeSpec;
  if (pinned) {
    spec = pinned; // 1 reuse the decision (supported OR unsupported)
  } else {
    const fast = fastPath(ctx); // 2 canonical preset, no LLM
    if (fast) spec = fast;
    else if (detect) spec = validateSpec(await detect(ctx), ctx); // 3 AI faculty + audit
    else return unsupported("no supported runtime detected (and no detector available)");
  }
  return densifyNextPreview(spec, ctx);
}

/** Compose the shell command for a boot mode from a (supported) spec. Both modes
 *  install first (idempotent + fast when the worktree is warm, correct when it's a
 *  cold checkout), then `dev` runs the HMR server and `build` runs build + serve.
 *  Prefixes a `cd <appRoot>` when the app isn't at root. $PORT is expanded by the
 *  supervisor. */
/** Forge image has no native @next/swc by default in app worktrees; BROKK-31
 *  installs `@next/swc-linux-x64-gnu` before boot. Keep `--webpack` as an
 *  explicit escape hatch (BROKK_NEXT_WEBPACK=1) for worktrees that still fail. */
function ensureNextWebpack(cmd: string): string {
  if (process.env.BROKK_NEXT_WEBPACK !== "1") return cmd;
  if (!/\bnext\s+dev\b/.test(cmd) || /\s--webpack\b/.test(cmd)) return cmd;
  return cmd.replace(/\bnext\s+dev\b/, "next dev --webpack");
}

export function composeCommand(
  spec: RuntimeSpec,
  mode: "dev" | "build",
  opts?: {
    /** Drop the install step. The caller must have established that the worktree's
     *  dependencies already match its lockfile — see the supervisor's install
     *  stamp. Install is idempotent but NOT free: on a warm preview it was the
     *  bulk of the wake, and being glued to the dev command made it invisible to
     *  instrumentation (both live in one `sh -c`). */
    skipInstall?: boolean;
  },
): string {
  const install = opts?.skipInstall ? undefined : spec.install;
  const run =
    mode === "dev"
      ? [install, ensureNextWebpack(spec.dev)].filter(Boolean)
      : [install, spec.build, spec.start].filter(Boolean);
  const root = spec.appRoot && spec.appRoot !== "." ? `cd ${spec.appRoot} && ` : "";
  return `${root}${run.join(" && ")}`;
}
