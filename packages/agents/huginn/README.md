# `@brokk/huginn`

Huginn owns **Discovery → QA** on Brokk ([ADR 0067](https://edda.coldcodelabs.com/decisoes/0067-brokk-huginn-discovery-qa/)).

| Phase | Huginn | Notes |
|-------|--------|--------|
| Discovery | yes | Connect fires brief + QA catalog |
| QA LLM / Automated | yes (orchestration) | Execution under Sindri |
| Forge | proposes only | Cards from missing / scenarios / fail\|blocked |

Import Discovery/QA/runtime from here. Muninn + Resolve stay on `@brokk/scout`.
