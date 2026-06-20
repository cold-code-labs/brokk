"use client";

import type { Project } from "@brokk/sdk";
import { useEffect, useState } from "react";
import { brokk } from "../lib/api";

export default function Settings() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    brokk.listProjects().then(setProjects).catch(() => {});
  }, []);

  if (!mounted) return null;

  return (
    <div style={{ padding: "28px 32px", maxWidth: 820 }}>
      <h1 style={{ margin: 0, fontSize: 22, letterSpacing: -0.4 }}>Settings</h1>
      <p style={{ margin: "4px 0 20px", color: "#9aa3b2", fontSize: 14 }}>
        Projects the forge works on — repo, model, and auth mode.
      </p>

      {projects.map((p) => (
        <section key={p.id} style={card}>
          <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>{p.name}</h2>
          <Row k="Model" v={p.model} />
          <Row k="Auth mode" v={p.authMode} />
          <Row k="Base branch" v={p.baseBranch} />
          <Row k="Allowed tools" v={p.allowedTools.length ? p.allowedTools.join(", ") : "engine default"} />
          <Row k="Project id" v={p.id} mono />
        </section>
      ))}
      {projects.length === 0 && <p style={{ color: "#3f4654", fontSize: 13 }}>No projects.</p>}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 12, padding: "7px 0", borderTop: "1px solid #12151c" }}>
      <span style={{ fontSize: 13, color: "#5c6575" }}>{k}</span>
      <span style={{ fontSize: 13, fontFamily: mono ? "ui-monospace, monospace" : undefined }}>{v}</span>
    </div>
  );
}

const card: React.CSSProperties = { background: "#0f121a", border: "1px solid #1c212c", borderRadius: 10, padding: 18, marginBottom: 14 };
