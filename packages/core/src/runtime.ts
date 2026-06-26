/**
 * Sleipnir — the runtime contract. One serialisable object (`RuntimeSpec`) that
 * fully describes how to run a checkout, and the read-only view (`DetectCtx`) the
 * Huginn skill + the validator reason over. The preview supervisor consumes only
 * `RuntimeSpec` — it never again knows the word "next". See docs/RUNTIME.md.
 *
 * Types only (zero runtime, zero deps) so @brokk/db and every other package can
 * reference the shape without a dependency cycle. The logic — allowlist,
 * validateSpec, fastPath, resolver — lives in @brokk/runtime.
 */

/** How a checkout is run. Produced by the resolver (pinned / fast-path / Huginn). */
export interface RuntimeSpec {
  /** Provider id that produced this spec, e.g. "nextjs". */
  id: string;
  /** Human label for the UI, e.g. "Next.js". */
  label: string;
  /** Subdir of the checkout that holds the app ("." = repo root). */
  appRoot: string;
  /** Install command (run once, in appRoot). */
  install: string;
  /** Dev / HMR command. May reference $PORT and $HOST. */
  dev: string;
  /** Prod build command (Fleet `build` previews). Optional. */
  build?: string;
  /** Prod serve command. May reference $PORT. Optional. */
  start?: string;
  /** HTTP path polled to decide "live". Default "/". */
  health?: string;
  /** Extra env injected into the process. */
  env?: Record<string, string>;
  /** Whether Sleipnir can actually boot this stack today (v1: only nextjs). */
  supported: boolean;
  /** Reason, when supported=false ("Vite app at apps/web — not promoted yet"). */
  reason?: string;
  /** Files that justify the decision — audited by the validator. */
  evidence?: string[];
  /** Detector confidence 0..1 (Huginn skill). */
  confidence?: number;
  /** How this spec was chosen — provenance for the UI + debugging.
   *  "ai" = Huginn's runtime skill; "override" = pinned/manual; "preset" = the
   *  cheap fast-path for a canonical match. */
  source: "ai" | "override" | "preset";
}

/** The read-only view of a checkout the skill + validator reason over. No
 *  execution — detection is purely from the tree + manifests. */
export interface DetectCtx {
  /** Checkout root (absolute). */
  dir: string;
  /** Tree, root + 2 levels (node_modules/.git/dist/.next excluded). */
  files: string[];
  /** Parsed root package.json, if any. */
  pkg?: Record<string, unknown>;
  /** Lazy file read, relative to `dir`. Returns null when absent/unreadable. */
  read(rel: string): string | null;
}
