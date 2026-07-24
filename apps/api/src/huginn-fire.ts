import type { AppDeps } from "./app.js";

/** Fire-and-forget Huginn scouts. Failures swallowed (UI can re-run). */
export function fireHuginnDiscovery(
  deps: AppDeps,
  projectId: string,
  opts?: { skipQa?: boolean },
): void {
  const base = (deps.sindriUrl ?? "").replace(/\/$/, "");
  if (!base) return;
  const headers: Record<string, string> = {};
  if (deps.runnerSecret) headers.authorization = `Bearer ${deps.runnerSecret}`;
  void fetch(`${base}/discover/${projectId}`, { method: "POST", headers }).catch(() => {});
  // Prototype birth (devFirst): QA maps the empty template — wait for Hero paint.
  if (!opts?.skipQa) {
    void fetch(`${base}/qa/${projectId}/discover`, { method: "POST", headers }).catch(() => {});
  }
}

/** Catalog QA against the repo as it stands (call after Hero lands). */
export function fireQaDiscover(deps: AppDeps, projectId: string): void {
  const base = (deps.sindriUrl ?? "").replace(/\/$/, "");
  if (!base) return;
  const headers: Record<string, string> = {};
  if (deps.runnerSecret) headers.authorization = `Bearer ${deps.runnerSecret}`;
  void fetch(`${base}/qa/${projectId}/discover`, { method: "POST", headers }).catch(() => {});
}

export function isHeroTask(task: {
  title?: string | null;
  dedupeKey?: string | null;
}): boolean {
  const title = task.title ?? "";
  const key = task.dedupeKey ?? "";
  return title.startsWith("Hero:") || key.startsWith("var-hero:");
}
