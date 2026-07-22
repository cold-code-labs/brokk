# Brokk Skills (ADR 0039)

A **Brokk Skill** is a package of `{ name, description, instructions | run }` that
Sindri reaches via `invoke_skill` (catalogue in the system prompt) or via the
composer **Skill** chip (pinned for the whole session).

## Where skills live

**Inside this repo:** `skills/<id>/SKILL.md` (YAML frontmatter + body).

```
skills/
  litr/SKILL.md
  litr-frontend-design/SKILL.md
  qa-review/SKILL.md
  full-qa/SKILL.md
```

Yggdrasil keeps **tokens / UI packages** — not craft playbooks. New instruction
skill = add a folder under `skills/` and ship; the chat image copies the tree
(`BROKK_SKILLS_DIR=/app/skills`).

## Full QA (Discovery → Execution)

- **Capability `qa-discover`** — scout builds a versioned scenario catalog
  (`qa_catalogs` + `.brokk/qa/scenarios.json`) with a **fingerprint** of
  routes/features/e2e. When those sources change, `GET /qa/:projectId` returns
  `stale: true` — re-run Discovery before trusting Full QA instructions.
- **Instruction `full-qa`** — Execution playbook for the live preview
  (Playwright MCP). Sindri cockpit chips: **Discover**, **Full QA**, **Targeted**.
- Huginn `discovery` stays product brief (`built`/`missing`); QA Discovery is
  user journeys only.

## Shape

```ts
interface Skill {
  name: string;
  description: string;    // trigger (when to use)
  instructions?: string;  // instruction skill (from SKILL.md body)
  run?: (input) => Promise<ToolResult>;  // capability skill (code)
}
```

| Kind | Source | Examples |
|------|--------|----------|
| Capability | `buildSkills()` in `apps/chat` | `discovery`, `enhance` |
| Instruction | `skills/*/SKILL.md` | `litr`, `litr-frontend-design` |

## How the model reaches them

1. **Catalogue** — name + trigger in the system prompt; model calls `invoke_skill`.
2. **Slash `/` in the Chat composer** — type `/` to pick a skill; the token stays in
   the draft (e.g. `/litr-frontend-design redesign the landing`). On send, the
   skill is stripped from the user text, pinned on the session, and injected as
   `## Active skill (pinned)` for API + CLI lanes.
3. **Pinned badge** — after the first slash use, the session shows `/{skill} pinned`.

`GET /skills` feeds the `/` menu. There is no Skill chip in the cockpit.

## Adding an instruction skill

1. Create `skills/<kebab-name>/SKILL.md` with frontmatter `name` + `description`.
2. Redeploy chat (image copies `skills/`).
3. Pick it in the Skill chip on a **new** chat (fixed at creation, like engine).

Capability skills still land in `buildSkills()` when they need host services
(checkout, Mímir, etc.).
