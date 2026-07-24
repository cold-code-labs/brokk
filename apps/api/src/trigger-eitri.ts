import type { AppDeps } from "./app.js";

/**
 * Fire-and-forget kick to Eitri's HTTP trigger (`POST /eitri/review`) so the
 * reviewer picks up a freshly-opened or freshly-pushed PR without waiting on a
 * GitHub webhook. Shared by the plan-open path and the plan-less run-complete
 * path so both lanes get an automatic review (and, on a passing gate, auto-merge).
 */
export async function triggerEitri(
  deps: Pick<AppDeps, "eitriUrl" | "runnerSecret">,
  repo: string,
  prNumber: number,
): Promise<{ ok: boolean; detail?: string }> {
  const base = (deps.eitriUrl ?? "").replace(/\/$/, "");
  if (!base) return { ok: false, detail: "EITRI_URL unset" };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.runnerSecret) headers.authorization = `Bearer ${deps.runnerSecret}`;
  try {
    const res = await fetch(`${base}/eitri/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ repo, prNumber }),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, detail: `${res.status} ${text.slice(0, 200)}` };
    return { ok: true, detail: text.slice(0, 200) || undefined };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
