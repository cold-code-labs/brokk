"use client";

import type { Project } from "@brokk/sdk";
import { useEffect, useState } from "react";
import { Main, PageHeader, EmptyState } from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { ThemeToggle } from "./ThemeToggle";

export default function Settings() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    brokk.listProjects().then(setProjects).catch(() => {});
  }, []);

  if (!mounted) return null;

  return (
    <Main style={{ maxWidth: "52rem" }}>
      <PageHeader
        title="Settings"
        description="Projects the forge works on — repo, model, and auth mode."
      />

      <div className="ygg-card" style={{ marginBottom: "1.4rem" }}>
        <div className="ygg-card-title">Appearance</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
            marginTop: "0.6rem",
          }}
        >
          <span style={{ color: "var(--fg-soft)" }}>Theme (light / dark)</span>
          <ThemeToggle />
        </div>
      </div>

      {projects.map((p) => (
        <div key={p.id} className="ygg-card" style={{ marginBottom: "0.9rem" }}>
          <div className="ygg-card-title">{p.name}</div>
          <div className="ygg-card-meta">
            <div>
              <b>Model</b>
              <span className="ygg-badge" data-tone="info">{p.model}</span>
            </div>
            <div>
              <b>Auth mode</b>
              <span className="ygg-badge" data-tone="info">{p.authMode}</span>
            </div>
            <div>
              <b>Base branch</b>
              <span>{p.baseBranch}</span>
            </div>
            <div>
              <b>Allowed tools</b>
              <span>{p.allowedTools.length ? p.allowedTools.join(", ") : "engine default"}</span>
            </div>
            <div>
              <b>Project id</b>
              <span style={{ fontFamily: "ui-monospace, monospace" }}>{p.id}</span>
            </div>
          </div>
        </div>
      ))}

      {projects.length === 0 && (
        <EmptyState
          title="No projects"
          description="Connect a repo to give the forge something to work on."
        />
      )}
    </Main>
  );
}
