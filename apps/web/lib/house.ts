// ─────────────────────────────────────────────────────────────────────────────
// House cockpit helpers — attention scoring + localStorage keys for the CCL
// software-house floor (pins, last chat session per project, intake drafts).
// ─────────────────────────────────────────────────────────────────────────────

import type { Task } from "@brokk/sdk";
import type { ProjectBrief } from "./chat";

export const HOUSE_PINS_KEY = "brokk.house.pins";
export const HOUSE_SESSIONS_KEY = "brokk.house.lastSessionByProject";
export const HOUSE_DRAFTS_KEY = "brokk.house.drafts";

/** Display label: `arte-one` → `Arte One`. Keeps already-spaced names as-is. */
export function prettyProjectName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  if (/\s/.test(trimmed) && /[A-ZÁÉÍÓÚÂÊÔÃÕÇÀÈÌÒÙ]/.test(trimmed)) return trimmed;
  return trimmed
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toLocaleUpperCase("pt-BR") + w.slice(1).toLocaleLowerCase("pt-BR"))
    .join(" ");
}

/** Quiet threshold: no task activity for this many days → attention bump. */
const QUIET_DAYS = 3;
const STALE_REVIEW_DAYS = 2;

export type BriefSnapshot = {
  status: ProjectBrief["status"] | null;
  missing: string[];
  running: boolean;
};

export function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

/** Higher = needs the operator more. Used to sort the House attention board. */
export function attentionScore(
  tasks: Task[],
  brief: BriefSnapshot | null | undefined,
  lifecycle?: import("@brokk/core").HouseLifecycle | null,
): number {
  let score = 0;
  const running = tasks.filter((t) => t.status === "running").length;
  const queued = tasks.filter((t) => t.status === "queued").length;
  const review = tasks.filter((t) => t.status === "review");
  score += running * 50;
  score += queued * 20;
  score += review.length * 30;
  for (const t of review) {
    const age = daysSince(t.updatedAt);
    if (age != null && age >= STALE_REVIEW_DAYS) score += 25;
  }

  if (brief?.running || brief?.status === "pending") score += 8;
  if (brief?.status === "failed") score += 35;
  if (brief?.status === "ready" && brief.missing.length > 0) {
    score += Math.min(brief.missing.length, 6) * 15;
  }

  // House lifecycle — undocumented / no objective jumps the queue for the human gate.
  if (lifecycle === "undocumented") score += 80;
  else if (lifecycle === "prototype") score += 25;
  else if (lifecycle === "archived") score -= 200;

  const last =
    tasks.length === 0
      ? null
      : tasks.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b)).updatedAt;
  const quiet = daysSince(last);
  if (tasks.length === 0) score += 20;
  else if (quiet != null && quiet >= QUIET_DAYS * 2) score += 40;
  else if (quiet != null && quiet >= QUIET_DAYS) score += 25;

  return score;
}

export function sortByAttention<T extends { id: string }>(
  projects: T[],
  scoreOf: (id: string) => number,
): T[] {
  return [...projects].sort((a, b) => {
    const d = scoreOf(b.id) - scoreOf(a.id);
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  });
}
