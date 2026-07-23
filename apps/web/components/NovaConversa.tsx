"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Main, Banner } from "@cold-code-labs/yggdrasil-react";
import { useToast } from "./Toaster";
import { useProject } from "../lib/project-context";

/**
 * Nova Conversa (ADR 0038 + 0070 H5). Nome opcional: sem nome → birth provisório
 * `p-<hex>` e a conversa abre; claim amigável vem depois (H6).
 */
export default function NovaConversa() {
  const router = useRouter();
  const toast = useToast();
  const { refresh, setCurrentId } = useProject();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create(opts?: { skipName?: boolean }) {
    if (busy) return;
    const trimmed = name.trim();
    if (!opts?.skipName && !trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trimmed ? { name: trimmed } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : "provisioning failed");
      const projectId: string | undefined = body?.project?.id;
      const previewUrl: string | undefined = body?.preview?.url;
      const label = trimmed || body?.displayName || "Novo projeto";
      toast(
        body?.provisional
          ? `${label} forjado (slug provisório) — ${previewUrl ?? "provisionando"}`
          : `${label} forjado — preview em ${previewUrl ?? "provisionando"}`,
        { tone: "ok" },
      );
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
              Nome opcional. Sem nome, abrimos o chat com slug provisório e você
              pede o que quer — o <span style={{ color: "var(--fg)" }}>prod</span>{" "}
              nasce no Publicar (claim de domínio amigável antes, se quiser).
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
          placeholder="Nome (opcional) — ex.: MarkupLab…"
          aria-label="Nome do projeto"
          autoFocus
        />
        <button
          type="button"
          className="forge-bar-send"
          onClick={() => create()}
          disabled={busy || !name.trim()}
        >
          {busy ? "Forjando…" : "Criar com nome"}
        </button>
        <button
          type="button"
          className="forge-bar-send"
          onClick={() => create({ skipName: true })}
          disabled={busy}
          style={{ marginLeft: 8 }}
        >
          {busy ? "Forjando…" : "Começar sem nome"}
        </button>
      </div>
      {name.trim() ? (
        <p className="forge-sub" style={{ marginTop: 4 }}>
          dev: <code>{slugify(name)}.preview.coldcodelabs.com</code> · prod (no Publish):{" "}
          <code>{slugify(name)}.coldcodelabs.com</code>
        </p>
      ) : (
        <p className="forge-sub" style={{ marginTop: 4 }}>
          Sem nome → slug técnico <code>p-…</code> no preview; claim amigável depois.
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
