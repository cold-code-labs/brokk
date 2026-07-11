"use client";

// ─────────────────────────────────────────────────────────────────────────────
// The Brokk cast — who DID a thing, shown as an avatar instead of "you". Each
// agent gets a coloured icon-badge keyed off a task's `createdBy` (huginn /
// sindri / brokk / eitri / mimir). Unknown / null = the human operator ("You").
// Icon-badges (lucide) are consistent + legible small; swap for portrait art
// later if wanted.
// ─────────────────────────────────────────────────────────────────────────────

import type { ComponentType } from "react";
import { Feather, MessageSquare, Hammer, ShieldCheck, BookText, User } from "lucide-react";

interface Member {
  label: string;
  color: string;
  Icon: ComponentType<{ size?: number | string }>;
}

const CAST: Record<string, Member> = {
  huginn: { label: "Huginn", color: "#7c6cf0", Icon: Feather },
  sindri: { label: "Sindri", color: "#2f81f7", Icon: MessageSquare },
  "sindri-plan": { label: "Sindri", color: "#2f81f7", Icon: MessageSquare },
  brokk: { label: "Brokk", color: "#d98a3d", Icon: Hammer },
  brokkr: { label: "Brokk", color: "#d98a3d", Icon: Hammer },
  eitri: { label: "Eitri", color: "#2ea043", Icon: ShieldCheck },
  mimir: { label: "Mímir", color: "#a371f7", Icon: BookText },
};

/** Resolve a `createdBy` string to a cast member (human operator as fallback). */
export function actorOf(createdBy?: string | null): Member {
  const key = (createdBy ?? "").toLowerCase();
  return CAST[key] ?? { label: createdBy || "You", color: "#6b7488", Icon: User };
}

export function AgentAvatar({
  createdBy,
  size = 20,
  showLabel = false,
}: {
  createdBy?: string | null;
  size?: number;
  showLabel?: boolean;
}) {
  const a = actorOf(createdBy);
  const Icon = a.Icon;
  return (
    <span title={a.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: size,
          height: size,
          borderRadius: size,
          background: `${a.color}22`,
          border: `1px solid ${a.color}66`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: a.color,
          flexShrink: 0,
        }}
      >
        <Icon size={Math.round(size * 0.56)} />
      </span>
      {showLabel && <span style={{ fontSize: 12, color: "var(--fg-dim)" }}>{a.label}</span>}
    </span>
  );
}
