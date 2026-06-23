/** Single source of truth for the forge's visual tokens. Components import from
 *  here instead of repeating magic hex — keeps Fleet, board, and drawer coherent
 *  (and fixes the low-contrast empty states the old inline styles shipped). */

export const t = {
  // surfaces (darkest → lightest) — routed to Yggdrasil tokens so every inline
  // style={{…}} flips with the light/dark toggle for free.
  bg: "var(--bg)",
  surface: "var(--panel)",
  surface2: "var(--panel-2)",
  surface3: "var(--bg-soft)",
  inset: "var(--bg)",
  // borders
  border: "var(--line)",
  border2: "var(--line-soft)",
  borderActive: "var(--accent)",
  // text
  text: "var(--fg)",
  textMuted: "var(--fg-soft)",
  textFaint: "var(--fg-dim)",
  // accent (structural) → token; `purple` stays a literal (semantic signal).
  accent: "var(--accent)",
  purple: "#a371f7",
} as const;

/** Status → color. The one place statuses are colored (was duplicated). */
export const STATUS_COLOR: Record<string, string> = {
  backlog: "#6b7488",
  queued: "#d2a000",
  running: "#2f81f7",
  review: "#a371f7",
  done: "#2ea043",
  succeeded: "#2ea043",
  failed: "#f85149",
  cancelled: "#6b7488",
};

export const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog",
  queued: "Queued",
  running: "Running",
  review: "Review · PR",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
