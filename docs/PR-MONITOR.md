# PR-monitor (ADR 0074 Fase 4)

AWF-style loop: feedback on a Brokk-owned PR → **revise** card → OpenHands on the
same branch → Eitri again.

## Events (GitHub webhook → `/webhooks/github`)

| Event | When | Action |
|---|---|---|
| `pull_request` closed+merged | merge | close card/plan (BROKK-45) |
| `pull_request_review` submitted | `CHANGES_REQUESTED` / remediation comment | enqueue revise |
| `pull_request_review_comment` created | line comment looks like a fix request | enqueue revise |
| `issue_comment` created | on a PR issue | enqueue revise if remediation-shaped |
| `check_suite` / `check_run` completed | `failure` / `timed_out` | enqueue CI heal revise |

## Matching

1. Forge stamp in PR body (`task \`<uuid>\``)
2. Else `findTaskForMergedPr` (URL / repo+number)

## Dedupe

`dedupeKey = pr-monitor:{repo}:#{n}:{source}:{sha12}:{eventKey}`

Also skips if `openReviseExists(prNumber)` or revision cap
(`BROKK_PR_MONITOR_MAX_REVISIONS`, default 3).

## Configure GitHub App / webhook

Subscribe to: `pull_request`, `pull_request_review`, `pull_request_review_comment`,
`issue_comment`, `check_suite`, `check_run`.
