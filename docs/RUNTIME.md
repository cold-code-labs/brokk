# Sleipnir — the runtime layer

> **Status:** plan (v1). Working name: **Sleipnir** — Odin's steed that runs across
> all worlds. The piece that knows how to *run any repo*, whatever its stack.
>
> **Scope of v1 (agreed):** ship the **contract + resolver**, with detection done
> **natively by Huginn as a skill** ([`runtime/SKILL.md`](./runtime/SKILL.md)) —
> **no human in the loop**: we trust Huginn's decided `RuntimeSpec`, guarded by an
> automatic allowlist + the session sandbox, not by an approval click. Today only
> `nextjs` resolves to `supported: true` and boots; every other stack is
> recognised, explained, and emitted `supported: false` → a clean `unsupported`
> state instead of a 90s boot-then-fail. Adding a stack later = one entry in
> [`runtime/runtime-providers.json`](./runtime/runtime-providers.json), no code.
> (asgard then gets a web app at its root and joins the dance.)

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

/** The read-only view of a checkout the skill + validator reason over.
 *  No execution — detection is purely from the tree + manifests. */
export interface DetectCtx {
  dir: string;                        // checkout root
  files: string[];                    // tree, root + 2 levels
  pkg?: Record<string, unknown>;      // parsed root package.json, if any
  read(rel: string): string | null;   // lazy file read, relative to dir
}
```

## Runtime by AI — detection is a Huginn skill

Detection is **not** a hand-written `if (deps.next)` ladder. It is a native
**Huginn faculty**, defined as a skill in [`runtime/SKILL.md`](./runtime/SKILL.md)
(mirroring the Litr design skill), reasoning over the machine-readable presets +
command **allowlist** in
[`runtime/runtime-providers.json`](./runtime/runtime-providers.json). Huginn
already reads the repo for its discovery brief — this rides that same read and
emits a `RuntimeSpec` alongside it. **We trust Huginn's decision; there is no
human approval step.**

Why that's safe without a human (the gate is *structural*, see the skill §"Why a
skill, and why no human gate"):

1. **Typed output** — Huginn fills a `RuntimeSpec` via structured output, never a
   raw shell string of its own invention.
2. **Allowlist** — every `install`/`dev`/`build`/`start` must match
   `runtime-providers.json -> allowlist` (`pnpm|npm|yarn|bun` + a known framework
   binary, `$PORT`/`$HOST` only; no `;`, pipe-to-shell, `sudo`, network). The
   **validator** (the one piece of trusted TS) rejects anything else → `unsupported`.
3. **Isolation** — the spec boots in the session sandbox ([brokk-isolation]) — the
   containment that lets us trust the decision instead of approving it.
4. **Repo content is data, not instructions** — Huginn must ignore any "run X"
   embedded in a README/comment; the spec comes from manifests + the allowlist.

**Adding a stack = one entry in `runtime-providers.json`** (label + detect signals
+ command template). No TS, no supervisor change. The skill picks it up; flip
`supported:true` to let it boot. v1 ships `nextjs: supported:true`; `vite`/`astro`
are present as `supported:false` — Huginn *recognises and explains* them but they
resolve `unsupported` until promoted. That is exactly "understands & passes
forward only Next today."

```ts
// packages/core/src/runtime.ts — the validator is the trusted boundary
export function validateSpec(spec: RuntimeSpec, ctx: DetectCtx): RuntimeSpec {
  const bad = [spec.install, spec.dev, spec.build, spec.start]
    .filter(Boolean)
    .find((cmd) => !matchesAllowlist(cmd!));      // regex set from runtime-providers.json
  if (bad) return { ...spec, supported: false, reason: `command rejected: ${bad}` };
  if (!ctx.read(join(spec.appRoot, "package.json"))) {
    return { ...spec, supported: false, reason: `no manifest at ${spec.appRoot}` };
  }
  return spec;
}
```

## The resolver

Precedence, computed **once at connect** and pinned (not re-inferred per boot):

1. **Pinned `project.runtime`** (`source:"override"` or a previously-pinned `"ai"`
   spec) — reuse the decision deterministically.
2. **Cheap fast-path** — for a canonical match (lockfile + framework dep + standard
   script) emit the preset directly, no LLM pass (`source:"preset"`).
3. **Huginn skill** — the AI faculty resolves the fuzzy/long-tail cases
   (`source:"ai"`), then `validateSpec` + pin.
4. **None / invalid** → `unsupported` with a `reason`. No 90s boot-then-fail.

```ts
// packages/runtime/src/resolve.ts
export async function resolveRuntime(project: Project, ctx: DetectCtx): Promise<RuntimeSpec> {
  if (project.runtime) return project.runtime;                 // 1 pinned
  const fast = fastPath(ctx);                                  // 2 canonical preset
  const spec = fast ?? validateSpec(await huginn.detectRuntime(ctx), ctx); // 3 AI + validate
  if (spec.supported) await pin(project.id, spec);             // store on project.runtime
  return spec;                                                 // 4 may be { supported:false }
}
```

## Where it plugs in (file-by-file change map)

**New package** `packages/runtime` (`@brokk/runtime`) — contract, fast-path,
`validateSpec`, resolver. Pure, no DB/no IO beyond the passed `read()`.
Unit-testable with fixture trees + the allowlist regression suite (malicious
specs must be rejected).

- `docs/runtime/SKILL.md` + `runtime-providers.json` — the Huginn skill + its
  presets/allowlist (the replicable knowledge base; **done**, this commit).
- `packages/agents/scout` (Huginn) — extend the discovery pass to emit a
  `RuntimeSpec` via structured output, grounded in the skill. One new tool/output
  schema; reuses the existing connect-time read.
- `packages/core/src/runtime.ts` — export `RuntimeSpec`, `DetectCtx`, `validateSpec`,
  `matchesAllowlist`.
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
  ("Este repositório não tem um runtime suportado ainda", + Huginn's `reason`)
  instead of the failure card. Show `spec.label` + `source` ("Next.js · detectado
  por Huginn") in the preview bar.
- `scripts/sindri-e2e.ts` — already asserts terminal state; assert `unsupported`
  carries a `detail`. (mini stays the green path; asgard becomes a clean
  `unsupported`, not a 90s `failed`.)

## OSS we lean on (per phase, build none of it)

| Need | OSS / spec | Phase |
|---|---|---|
| Ground-truth signals to feed Huginn's skill | **`@netlify/framework-info`** (MIT) | optional: seed `runtime-providers.json` / the fast-path |
| Source → OCI image, no Dockerfile, multi-stack | **Nixpacks** (Railway, MIT) — *already bundled in our Coolify* | the generic build engine (Phase 2) |
| Standardised, reproducible buildpacks | **Cloud Native Buildpacks / Paketo** (CNCF) | heavier alt to Nixpacks |
| Schema reference for "framework → commands/output" | **Vercel Build Output API** / framework presets | informs `RuntimeSpec` |
| User-declared toolchain | **devcontainer.json** (open spec) | Phase 3 (`source:"override"` ingest) |
| Pinned runtime versions | **mise** / asdf / Volta (`.tool-versions`, `engines`) | Phase 3 |
| Isolated sandbox to run the dev server | **e2b**, **Daytona** (OSS) | ties into [brokk-isolation] |

## Roadmap

- **v1 (this doc):** contract + `validateSpec` + resolver + the **Huginn runtime
  skill** wired into the discovery pass. `projects.runtime` + `previews.detail` +
  `unsupported` status. Supervisor consumes `RuntimeSpec`. Sindri UI shows the
  label + reason. **Only `nextjs` boots; everything else is recognised → `unsupported`.**
- **v2 — promote a stack:** ✅ `vite` + `astro` flipped to `supported:true` (preset
  + trusted mirror in `packages/runtime/src/providers.ts`; allowlist gained the
  `preview` verb for `vite preview`/`astro preview`). `node` stays recognised-only
  (no standard dev server / entrypoint convention — needs a heuristic). Still TODO:
  strengthen `appRoot` detection for monorepos (`apps/web`).
- **v3 — generic engine:** for stacks without a first-class preset, let the skill
  target a **Nixpacks**-built image (already in our Coolify) instead of a bespoke
  `dev`/`start`, so "anything Huginn can identify" can boot.
- **v4 — reproducible + isolated:** toolchain pinning (mise/`engines`) and harden the
  per-session sandbox (see [brokk-isolation]) — the trust anchor for the no-human
  AI path.

## Open decisions

1. **Name** — Sleipnir (proposed). Veto/replace freely.
2. **Fast-path or always-Huginn** — v1 keeps a cheap rule fast-path for canonical
   Next so we don't burn an LLM pass on the obvious case. If you'd rather Huginn
   own *every* decision (purer, costlier), drop the fast-path — the resolver seam
   already supports it.
3. **`unsupported` vs `failed`** — separate states. `unsupported` = Huginn knew up
   front there's nothing supported to run (or the spec failed validation); `failed`
   = a supported runtime booted and crashed. UI + e2e treat them differently.
4. **Re-detect cadence** — pinned on first connect (deterministic). When does it
   re-run? Proposed: on explicit `rescan` or when the framework manifest changes
   between turns. Never per boot.

[brokk-isolation]: ./NORTH-STAR.md
