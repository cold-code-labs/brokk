#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// Ledger smoke test — exercises the assurance ledger (ADR 0087 F0) against a
// REAL Postgres, through the production path: ensureSchema + createStore.
//
// The unit tests cover fingerprint and parsing. Only a real database covers what
// actually matters here — dedupe, suppression and regression live in constraints
// and state transitions, not in pure functions. The question this script asks is
// not "does the SQL compile?" but **does Eitri stop forgetting?**
//
// Point it at a THROWAWAY database — it deletes its own rows:
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:17-alpine
//   cd packages/db && BROKK_DATABASE_URL=postgres://postgres:x@127.0.0.1:55432/postgres \
//     pnpm db:push
//   BROKK_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55432/postgres \
//     pnpm --filter @brokk/db smoke
// Exit 0 = pass, 1 = checks failed, 2 = misconfigured (no database URL).
// ─────────────────────────────────────────────────────────────────────────────

import { createDb, createStore, ensureSchema } from "../src/index.js";

const URL = process.env.BROKK_TEST_DATABASE_URL;
if (!URL) {
  console.error("BROKK_TEST_DATABASE_URL not set — point it at a throwaway Postgres.");
  process.exit(2);
}

const REPO = "cold-code-labs/ledger-smoke";
const base = {
  repo: REPO,
  prNumber: 42,
  lensId: "review.correctness",
  axis: "review",
  severity: "critical",
  title: "Member can self-promote to Owner",
  filePath: "db/migrations/0025_rls.sql",
  body: "usuarios_update has no column guard",
};

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "✔" : "✘"} ${name}` + (ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`),
  );
}

const { db, client } = createDb(URL);
const store = createStore(db);

try {
  await ensureSchema(db);
  // Clean fixture — the run must measure the ledger, not the leftovers of the
  // previous run. (First draft of this script didn't, and "reported" two failures
  // that were its own residue.)
  await client`delete from findings where repo = ${REPO}`;
  console.log("ensureSchema applied the ledger; fixture clean\n");

  const first = await store.recordFinding({
    ...base,
    lineStart: 12,
    proofRef: "RLS test: member UPDATE role=owner must fail",
  });
  check("first sighting → new", first.verdict, "new");

  // Why the line number is NOT in the fingerprint: files grow, defects don't move.
  // If this ever says "new", Eitri is spamming the PR again.
  const moved = await store.recordFinding({ ...base, lineStart: 47 });
  check("same defect, line moved → recurring", moved.verdict, "recurring");
  check("  …and it is the same ledger row", moved.id === first.id, true);

  await store.triageFinding(first.id, "wontfix", {
    reason: "by design: the gate is enforced in the BFF",
    actor: "ledger-smoke",
  });
  const silenced = await store.recordFinding({ ...base, lineStart: 47 });
  check("after wontfix → suppressed", silenced.verdict, "suppressed");
  check("  …and the comment can say why", silenced.triageReason, "by design: the gate is enforced in the BFF");

  let refused = false;
  try {
    await store.triageFinding(first.id, "wontfix", { reason: "   " });
  } catch {
    refused = true;
  }
  check("dismissal with no reason → refused", refused, true);

  await client`update findings set status = 'fixed' where id = ${first.id}`;
  const back = await store.recordFinding({ ...base, lineStart: 9 });
  check("fixed finding that comes back → regression", back.verdict, "regression");

  const other = await store.recordFinding({ ...base, title: "Missing index on hot query", severity: "medium" });
  check("different defect, same file → new", other.verdict, "new");
  check("  …and it does not collide", other.id !== first.id, true);

  const trail = (await client`
    select kind, count(*)::int as n from finding_events e
      join findings f on f.id = e.finding_id
     where f.repo = ${REPO} group by kind order by kind
  `) as unknown as { kind: string; n: number }[];
  const kinds = trail.map((r) => r.kind);
  check("audit trail records seen/triaged/regression", ["seen", "triaged", "regression"].every((k) => kinds.includes(k)), true);
  console.log(`\ntrail: ${trail.map((r) => `${r.kind}×${r.n}`).join(" · ")}`);

  await client`delete from findings where repo = ${REPO}`;
} finally {
  await client.end();
}

console.log(failures === 0 ? "\n✅ ledger smoke passed" : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
