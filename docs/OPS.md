# Brokk Ops — pulse da esteira

Toda operação que entra no Forge (Svalinn, QA, review, UI…) é um **card**
(`task`) + **run**. Não há entidade Job separada. A House pinta a borda do
card do projeto a partir dos contadores; a API `/ops` é o mesmo sinal para
máquinas e para o operador.

## Auth

```http
Authorization: Bearer <BROKK_API_SECRET>
```

(BFF web injeta; Chat/House usam `/api/ops/…`.)

## Endpoints

| | |
|---|---|
| `GET /ops` | contrato |
| `GET /ops/pulse?projectId=` | floor: projetos quentes + jobs |
| `GET /ops/jobs/:taskId` | status de um job (task + latest run) |
| `GET /ops/jobs/:taskId/events` | 307 → SSE `/runs/by-task/:id/events` |
| `POST /ops/start` | dispara op (incl. `svalinn-smoke`) → card `queued` |

### `POST /ops/start`

```json
{
  "kind": "svalinn-smoke",
  "targetSlug": "logcheck",
  "findingId": optional-uuid
}
```

Kinds: `svalinn-smoke` · `svalinn-remediate` · `brief`.

Resposta traz `job`, `pulse`, `events` — poll até `terminal: true`.

## House borders (`OpStatus`)

| op | borda | significado |
|---|---|---|
| `queued` | âmbar | card(s) na fila do Forge |
| `forging` | ember | run ativo |
| `review` | warning | PR / review |
| `failed` | danger | falha |
| `idle` | quiet | sem trabalho quente |
| `objective` | accent | falta travar objetivo |

Quando um job da fila é claimado, o card sai de âmbar → ember; ao terminar,
volta a idle (ou review).

## Svalinn

Findings continuam no Svalinn. Brokk só **executa** (`/ops/start` → ingress) e
**fecha** via `POST /svalinn/findings/:id/status` depois do merge. Card `done`
≠ finding `fixed`.
