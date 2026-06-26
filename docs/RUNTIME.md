# Sleipnir — the runtime layer

> **Status:** plan (v1). Working name: **Sleipnir** — Odin's steed that runs across
> all worlds. The piece that knows how to *run any repo*, whatever its stack.
>
> **Scope of v1 (agreed):** ship the **contract + resolver + provider registry**,
> but with **exactly one working provider: Next.js**. Everything non-Next resolves
> to a clean `unsupported` state (with a reason) instead of a hardcoded boot that
> fails after ~90s. Adding the second stack later = implement one `RuntimeProvider`,
> nothing else. (asgard then gets a web app at its root and joins the dance.)

## Why this exists

Today the preview boot assumes a single runtime, cravado in two places:

- [`apps/forge/src/config.ts`](../apps/forge/src/config.ts) — `previewDevCmd` is a global
  shell string: `pnpm install … && pnpm exec next dev -p $PORT -H 0.0.0.0`.
- [`apps/forge/src/preview.ts`](../apps/forge/src/preview.ts) — the supervisor hard-checks
  `package.json` at the checkout **root**, then `sh -c <that one command>`.
- [`packages/db/src/schema.ts`](../packages/db/src/schema.ts) — `projects` has **no runtime
  field**; every project is implicitly "Next.js at root, pnpm".

That held while the whole fleet was the Next template. It breaks the moment a
project isn't that shape — `cold-code-labs/asgard` (a spec/docs repo: `docs/`,
`examples/`, `routing/`, no `package.json`) reaches `failed` because `next dev`
has nothing to boot. This is exactly why deploy platforms (Vercel, Railway,
Render, Netlify, Fly) ask you to pick — or confirm a *detected* — framework /
build / runtime. Sleipnir is that layer for us.

"Runtime" is an umbrella for five contracts we currently assume:

1. **Detection** — what is this repo? (Next, Vite, Astro, Node, Python, static, …)
2. **Build** — package manager, install cmd, build cmd, output dir.
3. **Run** — dev (HMR) vs prod (build+serve); command, port, env.
4. **Toolchain** — pinned Node/Bun/Python version (reproducible).
5. **App-root** — which subdir is the app (`.` vs `apps/web`).

## The contract (`RuntimeSpec`)

The replicable core. One serialisable object that fully describes how to run a
checkout. The supervisor consumes only this — it never again knows the word
"next".

```ts
// packages/core/src/runtime.ts  (new)
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
  /** How this spec was chosen — provenance for the UI + debugging. */
  source: "override" | "auto" | "preset";
}
```

## The provider registry (how you add a stack)

A `RuntimeProvider` is the *only* thing you write to support a new stack. It does
cheap, read-only detection from the checkout tree and returns a `RuntimeSpec` or
`null`. The registry is an ordered list; the resolver tries each until one bites.

```ts
// packages/core/src/runtime.ts
export interface DetectCtx {
  dir: string;                         // checkout root
  files: string[];                     // shallow file list (root + one level)
  pkg?: Record<string, unknown>;       // parsed root package.json, if any
  read(rel: string): string | null;    // lazy file read, relative to dir
}

export interface RuntimeProvider {
  id: string;
  label: string;
  /** Return a spec if this provider recognises the repo, else null. */
  detect(ctx: DetectCtx): RuntimeSpec | null;
}
```

### v1 registry — Next.js only

```ts
// packages/runtime/src/providers/nextjs.ts  (the ONE working provider)
export const nextjs: RuntimeProvider = {
  id: "nextjs",
  label: "Next.js",
  detect(ctx) {
    const deps = { ...(ctx.pkg?.dependencies ?? {}), ...(ctx.pkg?.devDependencies ?? {}) };
    if (!("next" in deps)) return null;                 // not a Next app → pass
    const pm = pickPackageManager(ctx);                 // pnpm | npm | yarn | bun
    return {
      id: "nextjs", label: "Next.js", appRoot: ".",
      install: `${pm} install --no-frozen-lockfile`,
      dev: `${pm} exec next dev -p $PORT -H 0.0.0.0`,
      build: `${pm} exec next build`,
      start: `${pm} exec next start -p $PORT -H 0.0.0.0`,
      health: "/", source: "auto",
    };
  },
};

// packages/runtime/src/registry.ts
export const PROVIDERS: RuntimeProvider[] = [nextjs];   // ← add the next one here, later
```

> **This is the whole "replicable structure":** the contract + the registry +
> the resolver below. Supporting Vite is then `providers/vite.ts` + one line in
> `PROVIDERS`. No supervisor changes, no schema changes.

## The resolver

Precedence, computed at boot (and previewable at connect):

1. **`project.runtime` override** (a stored `RuntimeSpec`, `source:"override"`) — the
   manual escape hatch, exactly like Vercel's "override" toggles.
2. **Auto-detect** — first provider in `PROVIDERS` that returns non-null.
3. **None** → `unsupported`. The supervisor marks the preview `unsupported` with a
   human reason ("no supported runtime detected at root — looked for: Next.js").
   No 90s boot-then-fail.

```ts
// packages/runtime/src/resolve.ts
export function resolveRuntime(project: Project, ctx: DetectCtx): RuntimeSpec | null {
  if (project.runtime) return { ...project.runtime, source: "override" };
  for (const p of PROVIDERS) { const s = p.detect(ctx); if (s) return s; }
  return null;
}
```

## Where it plugs in (file-by-file change map)

**New package** `packages/runtime` (`@brokk/runtime`) — contract, registry,
providers, resolver. Pure, no DB/no IO beyond the passed `read()`. Unit-testable
with fixture trees.

- `packages/core/src/runtime.ts` — export `RuntimeSpec`, `RuntimeProvider`, `DetectCtx`.
- `packages/db/src/schema.ts`
  - `projects`: add `runtime jsonb` (nullable; null = auto each boot).
  - `previews`: add `detail text` (nullable) — carries the `unsupported`/failure
    reason. (Today there is no such column; the UI shows a generic "falhou".)
  - add preview status `unsupported` to the enum (distinct from `failed` = booted
    and crashed).
- [`apps/forge/src/preview.ts`](../apps/forge/src/preview.ts)
  - Replace the root `package.json` guard + `expandCmd(previewDevCmd)` with:
    build `DetectCtx` from `wtPath` → `resolveRuntime(project, ctx)`.
    - `null` → set preview `unsupported` + `detail`, return (no spawn).
    - spec → `cd $appRoot && <install> && <dev|build+start>` with `$PORT/$HOST`
      expanded; same spawn/log/reaper plumbing as today.
  - Healthcheck polls `spec.health` to flip `starting → live`.
- [`apps/forge/src/config.ts`](../apps/forge/src/config.ts) — `previewCmd`/`previewDevCmd`
  become the **fallback** the Next provider emits, not the law. Keep the env vars as
  a global override for ops, but they stop being the only path.
- `apps/web` (Sindri preview pane) — render the `unsupported` state explicitly
  ("Este repositório não tem um runtime suportado ainda") instead of the failure
  card. Show `spec.label` + `source` ("Next.js · detectado") in the preview bar.
- `scripts/sindri-e2e.ts` — already asserts terminal state; assert `unsupported`
  carries a `detail`. (mini stays the green path; asgard becomes a clean
  `unsupported`, not a 90s `failed`.)

## OSS we lean on (per phase, build none of it)

| Need | OSS / spec | Phase |
|---|---|---|
| Detect framework + dev/build cmds from a repo | **`@netlify/framework-info`** (MIT) | can back the providers' `detect()` |
| Source → OCI image, no Dockerfile, multi-stack | **Nixpacks** (Railway, MIT) — *already bundled in our Coolify* | the generic build engine (Phase 2) |
| Standardised, reproducible buildpacks | **Cloud Native Buildpacks / Paketo** (CNCF) | heavier alt to Nixpacks |
| Schema reference for "framework → commands/output" | **Vercel Build Output API** / framework presets | informs `RuntimeSpec` |
| User-declared toolchain | **devcontainer.json** (open spec) | Phase 3 (`source:"override"` ingest) |
| Pinned runtime versions | **mise** / asdf / Volta (`.tool-versions`, `engines`) | Phase 3 |
| Isolated sandbox to run the dev server | **e2b**, **Daytona** (OSS) | ties into [brokk-isolation] |

## Roadmap

- **v1 (this doc):** contract + registry + resolver + Next provider. `projects.runtime`
  + `previews.detail` + `unsupported` status. Supervisor consumes `RuntimeSpec`.
  Sindri UI shows runtime label + the `unsupported` state. **Only Next boots.**
- **v2 — second stack:** add `providers/vite.ts` (or `astro`, `node`) — proves the
  registry. `appRoot` detection for monorepos (`apps/web`). Manual override UI in
  the Sindri/Heimdall project settings.
- **v3 — generic engine:** swap bespoke `dev`/`start` for a **Nixpacks**-built image
  for stacks without a first-class provider. Detection-at-connect via **Huginn**
  (it already reads the repo for the discovery brief — extend it to emit a
  `RuntimeSpec`, stored as the `auto` default).
- **v4 — reproducible + isolated:** toolchain pinning (mise/engines) and run the dev
  server in a per-session sandbox (see [brokk-isolation]).

## Open decisions

1. **Name** — Sleipnir (proposed). Veto/replace freely.
2. **Detect lazily vs at connect** — v1 detects at boot (simplest, always fresh). v3
   moves it to Huginn at connect for a faster first preview + an editable default.
3. **`unsupported` vs `failed`** — proposed: separate states. `unsupported` = we
   knew up front there's nothing to run (no provider matched); `failed` = a matched
   runtime booted and crashed. The UI and the e2e treat them differently.
4. **Where the override UI lives** — Heimdall project settings (fleet-wide) vs the
   Sindri header (per session). Lean Heimdall; Sindri reads it.

[brokk-isolation]: ./NORTH-STAR.md
