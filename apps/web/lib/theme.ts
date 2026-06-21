/** Single source of truth for the forge's visual tokens. Components import from
 *  here instead of repeating magic hex — keeps Fleet, board, and drawer coherent
 *  (and fixes the low-contrast empty states the old inline styles shipped). */

export const t = {
  // surfaces (darkest → lightest)
  bg: "#0b0d12",
  surface: "#0f121a",
  surface2: "#141823",
  surface3: "#1a2030",
  inset: "#08090d",
  // borders
  border: "#1c212c",
  border2: "#222836",
  borderActive: "#2f81f7",
  // text — faint bumped to ≥4.5:1 on surface (old #3f4654 was ~1.6:1, invisible)
  text: "#e6e8ee",
  textMuted: "#9aa3b2",
  textFaint: "#6b7488",
  // accents
  accent: "#2f81f7",
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
