# `@brokk/huginn`

Huginn owns **Discovery → QA** on Brokk ([ADR 0067](https://edda.coldcodelabs.com/decisoes/0067-brokk-huginn-discovery-qa/)). Story loop: [ADR 0069](../../../docs/adr/0069-brokk-story-qa-eitri-trigger.md) — `qa-fail` → Plan por módulo → forge sem PR → re-QA → um PR → Eitri trigger.

| Phase | Huginn | Notes |
|-------|--------|--------|
| Discovery | yes | Connect fires brief + QA catalog |
| QA LLM / Automated | yes (orchestration) | Execution under Sindri |
| Forge | proposes only | Cards from missing / scenarios / fail\|blocked |
| Story | approve-qa-stories | 1 module = 1 Plan = 1 PR |

Import Discovery/QA/runtime from here. Muninn + Resolve stay on `@brokk/scout`.
