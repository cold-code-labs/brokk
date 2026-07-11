"use client";

import type { Preview } from "@brokk/sdk";

interface Props {
  preview: Preview;
  /** Called when the user clicks ✕ (stop if live/starting, dismiss if failed). */
  onStop: () => void;
}

/**
 * Inline status chip for a dev-preview environment, in the forge vocabulary
 * (forge-chip). The ember marks a build actually running; a live preview is
 * cold accent — the URL is the message.
 * – starting: ember dot (work in the fire) + "starting…"
 * – live:     accent chip, clickable URL
 * – failed:   names what broke; ✕ dismisses
 * Rendered on the Fleet project card and on the Board header.
 */
export function PreviewChip({ preview, onStop }: Props) {
  const chipClass =
    preview.status === "starting"
      ? "forge-chip is-ember"
      : preview.status === "live"
        ? "forge-chip is-accent"
        : "forge-chip";

  const dot = (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: "currentColor",
        display: "inline-block",
      }}
    />
  );

  return (
    <span className={chipClass}>
      {preview.status === "live" ? (
        <a
          href={preview.url}
          target="_blank"
          rel="noreferrer"
          style={{
            color: "inherit",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {dot}
          preview live ↗
        </a>
      ) : preview.status === "starting" ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span className="forge-ember" style={{ width: 6, height: 6 }} />
          starting…
        </span>
      ) : preview.status === "failed" ? (
        <span
          title="Preview build failed. Dismiss, then start it again."
          style={{ color: "var(--err)", display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          {dot}
          preview failed
        </span>
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {dot}
          {preview.status}
        </span>
      )}

      {/* Stop / dismiss */}
      <button
        type="button"
        title={preview.status === "failed" ? "Dismiss" : "Stop preview"}
        onClick={onStop}
        style={{
          fontSize: 11,
          color: "var(--fg-dim)",
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
