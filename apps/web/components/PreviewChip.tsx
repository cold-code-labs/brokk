"use client";

import type { Preview } from "@brokk/sdk";
import { STATUS_COLOR, t } from "../lib/theme";

/** Preview status → indicator color. */
const PREVIEW_COLOR: Record<string, string> = {
  starting: STATUS_COLOR.running, // blue
  live: STATUS_COLOR.done,        // green
  failed: STATUS_COLOR.failed,    // red
  stopped: STATUS_COLOR.backlog,  // gray
};

interface Props {
  preview: Preview;
  /** Called when the user clicks ✕ (stop if live/starting, dismiss if failed). */
  onStop: () => void;
}

/**
 * Inline status chip for a dev-preview environment.
 * – starting: animated dot + label
 * – live:     clickable URL link + dot
 * – failed:   red dot + "failed" label
 * Rendered on the Fleet project card and on the Board header.
 */
export function PreviewChip({ preview, onStop }: Props) {
  const color = PREVIEW_COLOR[preview.status] ?? t.textMuted;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        padding: "4px 10px",
        borderRadius: 20,
        background: t.surface3,
        border: `1px solid ${color}44`,
      }}
    >
      {/* Status indicator */}
      {preview.status === "live" ? (
        <a
          href={preview.url}
          target="_blank"
          rel="noreferrer"
          style={{
            color,
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: color,
              display: "inline-block",
            }}
          />
          live ↗
        </a>
      ) : (
        <span
          style={{
            color,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: color,
              display: "inline-block",
            }}
          />
          {preview.status === "starting" ? "starting…" : preview.status}
        </span>
      )}

      {/* Stop / dismiss button */}
      <button
        type="button"
        title={preview.status === "failed" ? "Dismiss" : "Stop preview"}
        onClick={onStop}
        style={{
          fontSize: 11,
          color: t.textFaint,
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "0 2px",
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </span>
  );
}
