/**
 * After a QA Story's forge cards all land, kick Targeted QA on the scenario ids
 * (ADR 0069). Fire-and-forget via Sindri session + /full-qa prompt.
 */
import type { Plan, QaScenario } from "@brokk/core";
import type { Store } from "@brokk/db";

export interface StoryReQaDeps {
  store: Store;
  sindriUrl: string;
  runnerSecret: string;
}

function scenarioIdFromLabels(labels: string[] | null | undefined): string | null {
  for (const l of labels ?? []) {
    const m = /^qa-fail:(.+)$/i.exec(l);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function scenarioIdsForPlan(tasks: { labels: string[] | null }[]): string[] {
  const ids = new Set<string>();
  for (const t of tasks) {
    const id = scenarioIdFromLabels(t.labels);
    if (id) ids.add(id);
  }
  return [...ids];
}

function buildPrompt(opts: {
  runId: string;
  scenarios: QaScenario[];
  summary: string | null;
}): string {
  const catalog = {
    version: 1,
    runId: opts.runId,
    summary: opts.summary,
    stale: false,
    scenarios: opts.scenarios,
  };
  const head = `Execute Targeted QA for scenario(s): ${opts.scenarios.map((s) => s.id).join(", ")}. Pin /full-qa. This is Story re-QA after forge (ADR 0069) — validate the fixes on the story branch / live preview.`;
  const persistNote = `\n\nrunId=${opts.runId}. Between scenarios call invoke_skill → qa-progress {index,total,id,runId}. When done call invoke_skill → submit_qa_report with the same runId, results[], mode=targeted, and summary. Prefer engine cursor-cli.`;
  return `/full-qa ${head}${persistNote}\n\n\`\`\`json\n${JSON.stringify(catalog, null, 2)}\n\`\`\``;
}

/** Kick Targeted re-QA for a Story plan. Idempotent if already running/pass. */
export async function fireStoryReQa(deps: StoryReQaDeps, plan: Plan): Promise<void> {
  if (!plan.storyModule) return;
  if (plan.validationStatus === "running" || plan.validationStatus === "pass") return;
  const base = deps.sindriUrl.replace(/\/$/, "");
  if (!base) {
    console.warn(`[story-reqa] plan ${plan.id.slice(0, 8)}: BROKK_SINDRI_URL unset — skip`);
    return;
  }

  const tasks = await deps.store.getPlanTasks(plan.id);
  const ids = scenarioIdsForPlan(tasks);
  if (ids.length === 0) {
    await deps.store.updatePlan(plan.id, { validationStatus: "pass" });
    console.log(`[story-reqa] plan ${plan.id.slice(0, 8)}: no qa-fail scenarios — mark pass`);
    return;
  }

  const catalog = await deps.store.getQaCatalog(plan.projectId);
  const byId = new Map((catalog?.scenarios ?? []).map((s) => [s.id, s]));
  const scenarios: QaScenario[] = ids.map(
    (id) =>
      byId.get(id) ?? {
        id,
        title: id,
        module: plan.storyModule ?? "qa",
        priority: "p1" as const,
        role: "user",
        tags: [],
        preconditions: [],
        steps: [],
        expects: [],
      },
  );

  const run = await deps.store.createQaRun({
    projectId: plan.projectId,
    mode: "targeted",
    scenarioIds: ids,
    planId: plan.id,
  });
  await deps.store.updatePlan(plan.id, {
    validationStatus: "running",
    validationRunId: run.id,
  });

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.runnerSecret) headers.authorization = `Bearer ${deps.runnerSecret}`;

  try {
    const sessRes = await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId: plan.projectId,
        engine: "cursor-cli",
        model: "auto",
        title: `Story re-QA · ${plan.storyModule}`,
        createdBy: "brokk-story-reqa",
      }),
    });
    if (!sessRes.ok) {
      const err = await sessRes.text().catch(() => "");
      throw new Error(`session ${sessRes.status}: ${err.slice(0, 200)}`);
    }
    const sessJson = (await sessRes.json()) as { session: { id: string } };
    const sessionId = sessJson.session.id;
    await deps.store.updateQaRun(run.id, { sessionId });

    const prompt = buildPrompt({
      runId: run.id,
      scenarios,
      summary: catalog?.summary ?? null,
    });
    const msgRes = await fetch(`${base}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: prompt }),
    });
    if (!msgRes.ok) {
      const err = await msgRes.text().catch(() => "");
      throw new Error(`message ${msgRes.status}: ${err.slice(0, 200)}`);
    }
    console.log(
      `[story-reqa] plan ${plan.id.slice(0, 8)} → run ${run.id.slice(0, 8)} · ${ids.length} scen · session ${sessionId.slice(0, 8)}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[story-reqa] plan ${plan.id.slice(0, 8)} failed:`, msg);
    await deps.store
      .updatePlan(plan.id, { validationStatus: "fail" })
      .catch(() => {});
    await deps.store.updateQaRun(run.id, { status: "failed", error: msg }).catch(() => {});
  }
}
