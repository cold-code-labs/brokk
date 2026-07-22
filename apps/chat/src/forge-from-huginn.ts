/**
 * Huginn → Forge: turn Discovery/QA artifacts into proposed backlog cards.
 * Same labels/dedupe as apps/api `backlog-from-brief` / `backlog-from-qa` (ADR 0067).
 */
import type { Store } from "@brokk/db";
import type { QaCatalog, QaRun, Task } from "@brokk/core";

const DISCOVERY_LABEL = "discovery";
const QA_LABEL = "qa";
const QA_SCENARIO_LABEL = "qa-scenario";
const QA_FAIL_LABEL = "qa-fail";

/** Minimal project fields — store rows use Date; core Project uses ISO strings. */
type ProjectRef = { id: string; baseBranch: string };

function toCardTitle(item: string): string {
  const t = item.replace(/\s+/g, " ").trim();
  if (t.length <= 90) return t;
  return `${t.slice(0, 88).replace(/\s\S*$/, "")}…`;
}

function normItem(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
}

async function makeCard(
  store: Store,
  project: ProjectRef,
  seenLabels: Set<string>,
  input: {
    title: string;
    body: string;
    labels: string[];
    dedupeLabel: string;
    createdBy: string;
  },
): Promise<Task | "skipped"> {
  if (seenLabels.has(input.dedupeLabel.toLowerCase())) return "skipped";
  seenLabels.add(input.dedupeLabel.toLowerCase());
  return store.insertTask({
    projectId: project.id,
    title: toCardTitle(input.title),
    body: input.body,
    status: "backlog",
    baseBranch: project.baseBranch,
    createdBy: input.createdBy,
    labels: input.labels,
    planId: null,
    planKey: null,
    dependsOn: [],
  });
}

/** Product brief `missing[]` → discovery cards (Huginn Phase 2). */
export async function proposeFromBrief(
  store: Store,
  project: ProjectRef,
  brief: { missing: string[] },
): Promise<{ created: number; skipped: number }> {
  const existing = await store.listTasks({ projectId: project.id });
  const seenText = new Set(
    existing
      .filter((t) => (t.labels ?? []).includes(DISCOVERY_LABEL))
      .map((t) => normItem(t.title)),
  );
  const seenLabels = new Set((existing.flatMap((t) => t.labels ?? [])).map((l) => l.toLowerCase()));
  let created = 0;
  let skipped = 0;
  for (const item of brief.missing ?? []) {
    if (seenText.has(normItem(item)) || seenText.has(normItem(toCardTitle(item)))) {
      skipped++;
      continue;
    }
    const dedupe = `discovery:${normItem(item).slice(0, 80)}`;
    const r = await makeCard(store, project, seenLabels, {
      dedupeLabel: dedupe,
      title: toCardTitle(item),
      body: `${item}\n\n— proposto pela Discovery (Huginn)`,
      labels: [DISCOVERY_LABEL, dedupe],
      createdBy: "huginn",
    });
    if (r === "skipped") skipped++;
    else {
      created++;
      seenText.add(normItem(item));
    }
  }
  return { created, skipped };
}

/** QA catalog scenarios → checklist cards (not forge-ready via Approve all). */
export async function proposeFromQaCatalog(
  store: Store,
  project: ProjectRef,
  catalog: Pick<QaCatalog, "scenarios">,
): Promise<{ created: number; skipped: number }> {
  const existing = await store.listTasks({ projectId: project.id });
  const seenLabels = new Set((existing.flatMap((t) => t.labels ?? [])).map((l) => l.toLowerCase()));
  let created = 0;
  let skipped = 0;
  for (const s of catalog.scenarios ?? []) {
    const dedupe = `qa-scenario:${s.id}`;
    const r = await makeCard(store, project, seenLabels, {
      dedupeLabel: dedupe,
      title: `[QA] ${s.title}`,
      body: [
        `Cenário Discovery \`${s.id}\` · módulo=${s.module} · prioridade=${s.priority}`,
        "",
        "**Steps**",
        ...(s.steps?.length ? s.steps.map((x, i) => `${i + 1}. ${x}`) : ["- —"]),
        "",
        "— Huginn Discovery (cenário). Approve all não enfileira qa-scenario.",
      ].join("\n"),
      labels: [QA_LABEL, QA_SCENARIO_LABEL, dedupe],
      createdBy: "huginn",
    });
    if (r === "skipped") skipped++;
    else created++;
  }
  return { created, skipped };
}

/** QA run fail|blocked → forge-ready cards (Approve all enqueues qa-fail). */
export async function proposeFromQaFindings(
  store: Store,
  project: ProjectRef,
  run: Pick<QaRun, "id" | "mode" | "results">,
  catalog: Pick<QaCatalog, "scenarios"> | null,
): Promise<{ created: number; skipped: number }> {
  const existing = await store.listTasks({ projectId: project.id });
  const seenLabels = new Set((existing.flatMap((t) => t.labels ?? [])).map((l) => l.toLowerCase()));
  const byId = new Map((catalog?.scenarios ?? []).map((s) => [s.id, s]));
  let created = 0;
  let skipped = 0;
  for (const row of run.results ?? []) {
    if (row.verdict !== "fail" && row.verdict !== "blocked") continue;
    const scen = byId.get(row.id);
    const dedupe = `qa-fail:${row.id}`;
    const r = await makeCard(store, project, seenLabels, {
      dedupeLabel: dedupe,
      title: `[QA ${row.verdict}] ${scen?.title ?? row.id}`,
      body: [
        `Falha QA · cenário \`${row.id}\` · verdict **${row.verdict}**`,
        `run \`${run.id}\` · mode=${run.mode}`,
        "",
        "**Nota**",
        row.note || "—",
        "",
        "— Huginn QA → Forge. Approve all enfileira.",
      ].join("\n"),
      labels: [QA_LABEL, QA_FAIL_LABEL, dedupe],
      createdBy: "huginn",
    });
    if (r === "skipped") skipped++;
    else created++;
  }
  return { created, skipped };
}
