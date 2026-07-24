# Brokk Ingress — Devin-class card API (ADR 0074)

Stable contract for external services (Svalinn, Huginn, Slack, other CCL apps):
**respond → create a Forge card → same OpenHands esteira**.

## Auth

```http
Authorization: Bearer <BROKK_API_SECRET>
Content-Type: application/json
```

Same secret the web BFF already uses for mutations. Service tokens per-org = later.

## Create / enqueue a card

```http
POST /ingress/cards
```

```json
{
  "brief": "Fix the null deref in checkout when cart is empty",
  "title": "Checkout null deref",
  "projectId": "<uuid>",
  "dedupeKey": "svalinn:checkout:null-deref",
  "createdBy": "svalinn",
  "proposedOnly": false
}
```

| Field | Required | Notes |
|---|---|---|
| `brief` | yes | Work body / acceptance |
| `projectId` **or** `repoFullName` | one of | `owner/repo` auto-connects if needed |
| `title` | no | Defaults to first line of brief |
| `dedupeKey` | no | Idempotent — returns existing non-terminal task |
| `createdBy` | no | Actor label (default `ingress`) |
| `proposedOnly` | no | `true` → `backlog`; else `queued` for Forge claim |
| `baseBranch` | no | Override project base |

### Response `201`

```json
{
  "taskId": "…",
  "projectId": "…",
  "repositoryId": "…",
  "status": "queued",
  "events": "/runs/by-task/<taskId>/events",
  "task": "/tasks/<taskId>",
  "runs": "/tasks/<taskId>/runs",
  "source": "ingress"
}
```

`200` + `"deduped": true` when `dedupeKey` hits an active card.

## Alias

`POST /runs/from-brief` remains — same semantics for the queued path. Prefer **`/ingress/cards`** in new callers.

## Discovery

`GET /ingress` returns the contract summary.

## Chat handoff

OpenCode (Brokk Chat) uses the Brokk MCP tool `enqueue_card`, which calls this endpoint — interactive Plan stays in Chat; DoD work enters Forge as a card (ADR 0073).
