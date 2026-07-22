/**
 * Smoke helpers for Story QA grouping (ADR 0069) — no DB required.
 * Run: node --experimental-strip-types scripts/story-qa-smoke.mjs  (or after build)
 *
 * Arte One pilot: POST /projects/045c165b-…/approve-qa-stories { includeQueued: true }
 * expect module chamados → 1 plan, shared story/qa-chamados-* branch, 0 PRs until open-pr.
 */
import assert from "node:assert/strict";

function scenarioIdFromLabels(labels) {
  for (const l of labels ?? []) {
    const m = /^qa-fail:(.+)$/i.exec(l);
    if (m?.[1]) return m[1];
  }
  return null;
}

function moduleFromBody(body) {
  const m = /m[oó]dulo\s*=\s*([^\s·\n]+)/i.exec(body);
  return m?.[1]?.trim() || null;
}

function groupByModule(cards, catalogById) {
  const groups = new Map();
  for (const t of cards) {
    const scenId = scenarioIdFromLabels(t.labels);
    const mod =
      (scenId && catalogById.get(scenId)?.module) || moduleFromBody(t.body) || "qa";
    const key = mod.trim().toLowerCase() || "qa";
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  return groups;
}

const catalog = new Map([
  ["chamados-open-ticket", { module: "chamados" }],
  ["billing-invoice", { module: "billing" }],
]);

const cards = [
  {
    labels: ["qa", "qa-fail", "qa-fail:chamados-open-ticket"],
    body: "módulo=chamados",
  },
  {
    labels: ["qa-fail:chamados-open-ticket"],
    body: "",
  },
  {
    labels: ["qa-fail:billing-invoice"],
    body: "módulo=billing",
  },
];

const groups = groupByModule(cards, catalog);
assert.equal(groups.size, 2);
assert.equal(groups.get("chamados")?.length, 2);
assert.equal(groups.get("billing")?.length, 1);
assert.equal(scenarioIdFromLabels(cards[0].labels), "chamados-open-ticket");
assert.equal(moduleFromBody("Falha · módulo=chamados · prioridade=p0"), "chamados");

console.log("story-qa-smoke: ok — chamados×2 + billing×1");
