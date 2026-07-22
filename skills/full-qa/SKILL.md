---
name: full-qa
description: >-
  Full / targeted GUI QA: Discovery builds a versioned scenario catalog from the
  app (routes, features, e2e, modules); Execution drives the live preview with
  Playwright MCP across all or selected scenarios. Use for "full QA", "QA
  completo", "targeted QA", "descobrir cenários", "cenários desatualizados".
  Prefer this over qa-review when covering more than one named flow.
---

# Full QA (Discovery → Execution)

Two phases. Do not skip Discovery when the catalog is missing or **stale**.
Do not edit product code unless the user asked for fixes after the report.

## Catalog (source of truth)

Brokk stores the catalog per project. On disk in the checkout (when present):

`.brokk/qa/scenarios.json`

Shape:

```json
{
  "version": 1,
  "fingerprint": "<hash of routes/features/e2e>",
  "discoveredAt": "<iso>",
  "summary": "one paragraph",
  "scenarios": [
    {
      "id": "login-happy",
      "title": "Fazer login",
      "module": "auth",
      "priority": "p0",
      "role": "any",
      "tags": ["global"],
      "preconditions": ["logged out"],
      "steps": ["open /login", "…"],
      "expects": ["lands on home / dashboard"]
    }
  ]
}
```

If the chat/UI already pasted a catalog into the user message, use that — do not
re-invent scenarios.

## Phase A — Discovery

When the user asks to discover / refresh scenarios (or the catalog is stale):

1. Read `features.json`, `config/modules.ts` (or equivalent), app routes, existing
   `e2e/`, and any `.brokk/qa/scenarios.json`.
2. Build **global** scenarios: login, logout, session gate, empty/error states,
   one mobile viewport check when relevant.
3. Build **feature** scenarios from enabled modules (happy path + one edge each).
4. Keep ids stable kebab-case; prefer updating titles/steps over renaming ids.
5. Call `invoke_skill` → **qa-discover** when available (writes the catalog).
   Otherwise write `.brokk/qa/scenarios.json` and summarize the matrix.
6. Report: count by tag, p0 list, and whether fingerprint changed.

Discovery may skim the live preview nav to fill gaps — it must not run the full
matrix.

## Phase B — Execution

Needs live preview URL + Playwright tools (`mcp__playwright-chat__*` /
`mcp__playwright__*`). Prefer engine **`cursor-cli`** (CURSOR_API_KEY).
`claude-cli` also works when Claude Code OAuth is allowed. If neither CLI lane
has browser tools, say so and stop.

**Watch live:** Preview panel → **Assistir o agente** (MJPEG of the shared
Chromium). Prefer that while driving scenarios so the human can follow along.

Modes:

- **Full** — every scenario, p0 first, then p1/p2. Serial. Reset auth between
  scenarios that need a clean session.
- **Targeted** — only the ids/modules named in the user message.

Method (same honesty as `qa-review`):

1. Navigate → snapshot before acting → never click blind.
2. Login via **"Entrar como demo"** or the app's documented test login.
3. Before each scenario call `invoke_skill` → **qa-progress** with
   `{ index, total, id, runId }` (use `runId` from the user message when present).
4. Follow `steps[]`; assert `expects[]` with snapshots/screenshots on fail.
5. Verdict per scenario: `pass` | `fail` | `blocked` (agent could not operate UI).
6. After the run, call `invoke_skill` → **submit_qa_report** with
   `{ runId, mode, results: [{id, verdict, note}], summary }` — this persists the
   run in Brokk and writes `.brokk/qa/last-report.md`. Do not skip the tool in
   favor of prose-only reports.

## Staleness (why re-discover)

The catalog fingerprint covers feature manifests, module registries, routes, and
e2e specs. When developers add screens or flows, the fingerprint drifts → Brokk
marks the catalog **stale**. Stale catalogs mis-instruct QA (missing new flows,
ghost steps for removed UI).

If the UI/API says `stale: true`, or you notice routes/modules not in the
catalog:

1. Tell the user the catalog is outdated.
2. Prefer re-running Discovery before Full QA.
3. Targeted QA on an unchanged module is OK with a warning.

## Report shape

Lead with: **X passed · Y failed · Z blocked** (and stale? yes/no).

Then a table-like list: id · verdict · one-line note. Expand only failures.
No code speculation unless asked.
