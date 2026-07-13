# Brokk Skills (ADR 0039)

A **Brokk Skill** mirrors the Claude Code skill primitive: a package of
`{ name, description (its trigger), instructions body }` that Brokk — the chat
agent — loads on demand to do a kind of work. Naming doctrine (ADR 0039): the
app keeps its Norse name; the *features* it once carried as codenames become
skills with plain, functional names.

## The shape

Skills are defined by the `Skill` type in
[`packages/agents/chat/src/skills.ts`](../../packages/agents/chat/src/skills.ts):

```ts
interface Skill {
  name: string;          // stable id the model passes to invoke_skill
  description: string;    // the trigger — WHEN to reach for it (one line)
  instructions?: string;  // prose injected into the turn (pure-instruction skill)
  run?: (input) => Promise<{ ok: boolean; content: string }>;  // capability skill
}
```

Two flavors, same shape:

- **Capability skills** carry a `run()` — they execute and return a result
  (Discovery scouts the repo; Enhance rewrites a prompt).
- **Instruction skills** carry only `instructions` — invoking one injects that
  guidance into the turn, the pure Claude Code primitive.

## How the model reaches them

One tool, `invoke_skill(skill, input?)`. The catalogue (name + trigger) is
advertised in the system prompt by `buildSystemPrompt`, so the model knows what
exists and when to use it. This is the same host-injected bridge pattern as
`plan_work`: the Sindri app (`apps/chat/src/app.ts`, `buildSkills`) binds the
concrete handlers per turn, because they need the checkout + Mímir/Huginn config.

## The first two skills

| Skill | Was | What it does |
|---|---|---|
| `discovery` | Huginn / the Discovery page | Scouts the current checkout read-only, returns a structured brief (mission, built, missing, stack). |
| `enhance` | Mímir / the Mímir page | Rewrites a rough prompt into a sharper one (`mode`: polish \| structure \| engineer). |

Their old nav pages (`/mimir`, `/projects/[id]/descoberta`) stay routable as
break-glass but left the sidebar — the invocation path is now the skill.

## Adding a skill

Add an entry to `buildSkills()` in `apps/chat/src/app.ts` (or, for a
project-agnostic instruction skill, register one with `instructions` set). The
engines behind Brokk — Afl (kernel), Regin (missions), Sleipnir (runtime) —
stay invisible plumbing; they are not skills.
