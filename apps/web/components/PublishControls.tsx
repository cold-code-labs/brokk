"use client";

import { useState } from "react";
import { Rocket, History, RotateCcw, Loader2 } from "lucide-react";
import { Button } from "@cold-code-labs/yggdrasil-react";
import { useProject } from "../lib/project-context";
import { useToast } from "./Toaster";

interface Version {
  sha: string;
  message: string | null;
  committedAt: string | null;
}

/**
 * Publicar + Versões (ADR 0038 — the v0 face). For a dev-first app the user
 * iterates on the dev preview, then **Publicar** promotes dev→prod (the first
 * time, it gives birth to prod). **Versões** lists the published commits on main;
 * "Republicar" rolls prod back to an earlier one (forward-only). Renders nothing
 * for legacy (non-dev-first) projects. Posts to the BFF (/api/*), which injects
 * the API secret.
 */
export default function PublishControls({ projectId }: { projectId: string }) {
  const { projects, refresh } = useProject();
  const project = projects.find((p) => p.id === projectId);
  const toast = useToast();
  const [publishing, setPublishing] = useState(false);
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [loadingV, setLoadingV] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);

  // Only dev-first apps (born via Nova Conversa) get the v0 publish flow.
  if (!project?.devFirst) return null;

  async function loadVersions() {
    setLoadingV(true);
    try {
      const r = await fetch(`/api/conversations/${projectId}/versions`);
      const b = await r.json().catch(() => []);
      setVersions(Array.isArray(b) ? b : []);
    } catch {
      setVersions([]);
    } finally {
      setLoadingV(false);
    }
  }

  async function publish() {
    if (publishing) return;
    setPublishing(true);
    try {
      const r = await fetch(`/api/conversations/${projectId}/publish`, { method: "POST" });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof b?.error === "string" ? b.error : "falha ao publicar");
      toast("Publicado — prod atualizado.", { tone: "ok" });
      refresh();
      if (open) loadVersions();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: "err" });
    } finally {
      setPublishing(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && versions === null) loadVersions();
  }

  async function rollback(sha: string) {
    if (rollingBack) return;
    setRollingBack(sha);
    try {
      const r = await fetch(`/api/conversations/${projectId}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sha }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof b?.error === "string" ? b.error : "falha no rollback");
      toast(`Prod voltou para ${sha.slice(0, 7)}.`, { tone: "ok" });
      loadVersions();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: "err" });
    } finally {
      setRollingBack(null);
    }
  }

  return (
    <span style={{ position: "relative", display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button
        type="button"
        className={`sindri-preview-icon ${open ? "is-on" : ""}`}
        title="Versões publicadas"
        onClick={toggle}
      >
        <History size={15} />
      </button>
      <Button variant="default" size="sm" onClick={publish} disabled={publishing}>
        {publishing ? <Loader2 size={14} style={{ animation: "sindri-spin 0.7s linear infinite" }} /> : <Rocket size={14} />}
        <span style={{ marginLeft: 6 }}>Publicar</span>
      </Button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 60,
            width: 340,
            maxHeight: 360,
            overflowY: "auto",
            background: "var(--surface, #12161d)",
            border: "1px solid var(--border, #2a3340)",
            borderRadius: 10,
            boxShadow: "0 12px 40px rgba(0,0,0,.45)",
            padding: 10,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--fg, #e6edf3)",
              padding: "2px 4px 8px",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            Versões publicadas
            <span style={{ color: "var(--muted, #8b98a5)", fontWeight: 400 }}>
              {(versions ?? []).length || ""}
            </span>
          </div>
          {loadingV ? (
            <div style={{ padding: 12, color: "var(--muted, #8b98a5)", fontSize: 12 }}>
              <Loader2 size={13} style={{ animation: "sindri-spin 0.7s linear infinite" }} /> carregando…
            </div>
          ) : (versions ?? []).length === 0 ? (
            <div style={{ padding: 12, color: "var(--muted, #8b98a5)", fontSize: 12 }}>
              Nenhuma versão em prod ainda — clique em Publicar.
            </div>
          ) : (
            (versions ?? []).map((v, i) => (
              <div
                key={v.sha}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 4px",
                  borderTop: i === 0 ? "none" : "1px solid var(--border, #222a34)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: "var(--fg, #e6edf3)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {v.message || v.sha.slice(0, 7)}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted, #8b98a5)", fontFamily: "var(--font-mono, monospace)" }}>
                    {v.sha.slice(0, 7)}
                    {i === 0 ? " · atual (prod)" : v.committedAt ? " · " + v.committedAt.slice(0, 10) : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className="sindri-preview-icon"
                  title={i === 0 ? "Já é a versão em prod" : `Republicar ${v.sha.slice(0, 7)}`}
                  onClick={() => rollback(v.sha)}
                  disabled={i === 0 || rollingBack === v.sha}
                  style={{ opacity: i === 0 ? 0.4 : 1 }}
                >
                  {rollingBack === v.sha ? <Loader2 size={14} style={{ animation: "sindri-spin 0.7s linear infinite" }} /> : <RotateCcw size={14} />}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </span>
  );
}
