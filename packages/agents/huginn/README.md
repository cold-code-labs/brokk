# `@brokk/huginn`

Huginn owns **Discovery → QA** on Brokk. Forge stays the board (cards from fails).

| Phase | Huginn? | Notes |
|-------|---------|--------|
| Discovery | yes | brief + scenario catalog (+ runtime on connect) |
| QA LLM / QA Automated | yes (orchestration) | Execution engines under the same raven |
| Forge | no | Brokk board; Huginn only *proposes* via fail cards |

See **Edda ADR 0067**. Evolves ADR 0066. Piloto: Arte One.

Import this package — not `@brokk/scout` — for Discovery / QA catalog work.
