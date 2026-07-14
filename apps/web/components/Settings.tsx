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
    <Main className="forge-room is-narrow">
      {/* masthead — the toolbench */}
      <header className="forge-head">
        <div className="forge-head-top">
          <div className="forge-head-copy">
            <span className="forge-eyebrow">Brokk · the toolbench</span>
            <h1 className="forge-title">Settings</h1>
            <p className="forge-sub">Appearance, and each project&rsquo;s model, auth mode, and base branch.</p>
          </div>
        </div>
        <div className="forge-head-rule" />
      </header>

      <section className="forge-section">
        <div className="forge-h">
          <span className="forge-h-title">Appearance</span>
          <span className="forge-h-rule" />
        </div>
        <div className="forge-ledger">
          <div className="forge-row">
            <span className="forge-row-title">Theme</span>
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

        {projects.length > 0 && (
          <div className="forge-ledger">
            {projects.map((p) => (
              <div key={p.id} className="forge-row is-stack">
                <div className="forge-row-line">
                  <span className="forge-row-title" style={{ flex: "0 1 auto" }}>{p.name}</span>
                  <span className="forge-chip is-accent">{p.model || "engine default"}</span>
                  <span className="forge-chip">{p.authMode}</span>
                </div>
                <div className="forge-row-line">
                  <span className="forge-row-mono" title="Base branch">{p.baseBranch}</span>
                  <span className="forge-row-mono" title="Allowed tools">
                    {p.allowedTools.length ? p.allowedTools.join(", ") : "engine default"}
                  </span>
                  <span className="forge-row-mono is-end" title="Project id">{p.id}</span>
                </div>
              </div>
            ))}
          </div>
        )}

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
