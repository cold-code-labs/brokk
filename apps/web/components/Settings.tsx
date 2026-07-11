"use client";

import type { Project } from "@brokk/sdk";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Wrench } from "lucide-react";
import { Main, Button } from "@cold-code-labs/yggdrasil-react";
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
      {/* masthead — the toolbench */}
      <header className="forge-head">
        <div className="forge-head-top">
          <div>
            <span className="forge-eyebrow">Brokk · the toolbench</span>
            <h1 className="forge-title">Settings</h1>
            <p className="forge-sub">Appearance, and each project&rsquo;s model, auth mode, and base branch.</p>
          </div>
        </div>
        <div className="forge-head-rule" />
      </header>

      <section style={{ marginBottom: "2.2rem" }}>
        <div className="forge-h">
          <span className="forge-h-title">Appearance</span>
          <span className="forge-h-rule" />
        </div>
        <div className="forge-panel">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <span style={{ color: "var(--fg-soft)", fontSize: "0.9rem" }}>Theme</span>
            <ThemeToggle />
          </div>
        </div>
      </section>

      <section>
        <div className="forge-h">
          <span className="forge-h-title">Projects</span>
          <span className="forge-h-meta">{projects.length}</span>
          <span className="forge-h-rule" />
        </div>

        {projects.map((p) => (
          <div key={p.id} className="forge-panel" style={{ marginBottom: "0.9rem" }}>
            <div className="ygg-card-title">{p.name}</div>
            <div className="ygg-card-meta">
              <div>
                <b>Model</b>
                <span className="forge-chip is-accent">{p.model}</span>
              </div>
              <div>
                <b>Auth mode</b>
                <span className="forge-chip">{p.authMode}</span>
              </div>
              <div>
                <b>Base branch</b>
                <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{p.baseBranch}</span>
              </div>
              <div>
                <b>Allowed tools</b>
                <span>{p.allowedTools.length ? p.allowedTools.join(", ") : "engine default"}</span>
              </div>
              <div>
                <b>Project id</b>
                <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{p.id}</span>
              </div>
            </div>
          </div>
        ))}

        {projects.length === 0 && (
          <div className="forge-empty is-panel">
            <span className="forge-empty-mark"><Wrench /></span>
            <span className="forge-empty-title">The bench is clear</span>
            <p className="forge-empty-sub">
              Connected repos appear here with their model, auth mode, and base branch.
            </p>
            <span className="forge-empty-action">
              <Button asChild>
                <Link href="/connect">+ Connect a repo</Link>
              </Button>
            </span>
          </div>
        )}
      </section>
    </Main>
  );
}
