"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Main, Banner } from "@cold-code-labs/yggdrasil-react";
import { useToast } from "./Toaster";
import { useProject } from "../lib/project-context";

/**
 * Nova Conversa (ADR 0038 — the v0 face). Type a name → Heimdall provisions the
 * dev side (repo from the template + `<slug>_dev` Hauldr + `dev` branch), Brokk
 * registers the project + preview + Sindri session, and the conversation opens.
 * Prod is born later on the first Publish. The BFF (/api/*) injects the API
 * secret, so this posts to /api/conversations directly.
 */
export default function NovaConversa() {
  const router = useRouter();
  const toast = useToast();
  const { refresh, setCurrentId } = useProject();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : "provisioning failed");
      const projectId: string | undefined = body?.project?.id;
      const previewUrl: string | undefined = body?.preview?.url;
      toast(`${trimmed} forjado — preview em ${previewUrl ?? "provisionando"}`, { tone: "ok" });
      refresh();
      if (projectId) {
        setCurrentId(projectId);
        router.push("/chat");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Main className="forge-room is-tight">
      <header className="forge-head">
        <div className="forge-head-top">
          <div className="forge-head-copy">
            <span className="forge-eyebrow">Brokk · nova conversa</span>
            <h1 className="forge-title">Novo projeto</h1>
            <p className="forge-sub">
              Digite um nome. Provisionamos o ambiente de <span style={{ color: "var(--fg)" }}>dev</span> (repo +
              Hauldr + preview) e a conversa abre. O <span style={{ color: "var(--fg)" }}>prod</span> nasce quando
              você clicar em Publicar.
            </p>
          </div>
        </div>
        <div className="forge-head-rule" />
      </header>

      {err && <Banner tone="err">{err}</Banner>}

      <div className="forge-bar" style={{ marginBottom: 14 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="Nome do projeto (ex.: MarkupLab)…"
          aria-label="Nome do projeto"
          autoFocus
        />
        <button type="button" className="forge-bar-send" onClick={create} disabled={busy || !name.trim()}>
          {busy ? "Forjando…" : "Criar conversa"}
        </button>
      </div>
      {name.trim() && (
        <p className="forge-sub" style={{ marginTop: 4 }}>
          dev: <code>{slugify(name)}.preview.coldcodelabs.com</code> · prod (no Publish):{" "}
          <code>{slugify(name)}.coldcodelabs.com</code>
        </p>
      )}
    </Main>
  );
}

/** Mirror of Heimdall's slugify, for the preview of the resulting hostnames. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
