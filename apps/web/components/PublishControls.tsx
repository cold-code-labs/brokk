"use client";

import { useState } from "react";
import { Rocket, GitPullRequest, ChevronDown, RotateCcw, Loader2 } from "lucide-react";
import { useProject } from "../lib/project-context";
import { useToast } from "./Toaster";

interface Version {
  sha: string;
  message: string | null;
  committedAt: string | null;
}

const spin = { animation: "sindri-spin 0.7s linear infinite" } as const;

/**
 * The one hot action of the preview cockpit (ADR 0038 — the v0 face).
 *   - **Publicar** — shown until prod exists. The first publish gives birth to
 *     prod (provisions the prod Hauldr + Coolify app on main).
 *   - **Create PR** — shown once published. Further promotions open a PR dev→main
 *     that Eitri reviews (a `dev` head is never auto-merged) and the operator
 *     approves — the functions start to marry (forge → review → ship).
 * The ▾ opens the published-versions menu (rollback). Renders nothing for legacy
 * (non-dev-first) projects. Posts to the BFF (/api/*), which injects the secret.
 */
export default function PublishControls({ projectId }: { projectId: string }) {
  const { projects, refresh } = useProject();
  const project = projects.find((p) => p.id === projectId);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [loadingV, setLoadingV] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);

  if (!project?.devFirst) return null;
  const published = project.published;

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

  // Primary gesture: first time births prod (Publicar); after, opens the review PR.
  async function primary() {
    if (busy) return;
    setBusy(true);
    try {
      if (!published) {
        const r = await fetch(`/api/conversations/${projectId}/publish`, { method: "POST" });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof b?.error === "string" ? b.error : "falha ao publicar");
        toast("Publicado — prod no ar.", { tone: "ok" });
        refresh();
        if (open) loadVersions();
      } else {
        const r = await fetch(`/api/conversations/${projectId}/pr`, { method: "POST" });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof b?.error === "string" ? b.error : "falha ao abrir PR");
        toast(`PR #${b.number} ${b.created ? "aberto" : "já aberto"} — Eitri vai revisar.`, { tone: "ok" });
        if (b.url) window.open(b.url, "_blank", "noopener");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: "err" });
    } finally {
      setBusy(false);
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
    <span className="sindri-publish-wrap">
      <button type="button" className="sindri-publish" onClick={primary} disabled={busy}>
        {busy ? (
          <Loader2 size={14} style={spin} />
        ) : published ? (
          <GitPullRequest size={14} />
        ) : (
          <Rocket size={14} />
        )}
        {published ? "Create PR" : "Publicar"}
      </button>
      <button
        type="button"
        className="sindri-publish-caret"
        title="Versões publicadas"
        onClick={toggle}
        aria-expanded={open}
      >
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="sindri-publish-menu">
          <div className="sindri-publish-menu-title">
            Versões publicadas
            <span>{(versions ?? []).length || ""}</span>
          </div>
          {loadingV ? (
            <div className="sindri-publish-empty">
              <Loader2 size={13} style={spin} /> carregando…
            </div>
          ) : (versions ?? []).length === 0 ? (
            <div className="sindri-publish-empty">
              {published ? "Nenhuma versão listada." : "Nenhuma versão em prod ainda — clique em Publicar."}
            </div>
          ) : (
            (versions ?? []).map((v, i) => (
              <div key={v.sha} className="sindri-publish-ver">
                <div className="sindri-publish-ver-main">
                  <div className="sindri-publish-ver-msg">{v.message || v.sha.slice(0, 7)}</div>
                  <div className="sindri-publish-ver-sha">
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
                >
                  {rollingBack === v.sha ? <Loader2 size={14} style={spin} /> : <RotateCcw size={14} />}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </span>
  );
}
