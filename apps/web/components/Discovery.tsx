"use client";

import type { Project } from "@brokk/sdk";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Main, PageHeader, Banner, Button } from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { discovery, type ProjectBrief } from "../lib/chat";
import { useProject } from "../lib/project-context";
import { t } from "../lib/theme";

/** Huginn's project-discovery page — its own surface (not crammed into the Quadro).
 *  Shows what the project IS, what's BUILT, what's MISSING, and turns the "missing"
 *  items into proposed backlog cards. Polls while a scout is in flight. */
export default function Discovery({ projectId }: { projectId?: string }) {
  const { setCurrentId } = useProject();
  const [project, setProject] = useState<Project | null>(null);
  const [brief, setBrief] = useState<ProjectBrief | null>(null);
  const [running, setRunning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [proposedCount, setProposedCount] = useState(0);
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [appBusy, setAppBusy] = useState(false);

  // Viewing discovery IS selecting that environment — keep the global switcher in sync.
  useEffect(() => {
    if (projectId) setCurrentId(projectId);
  }, [projectId, setCurrentId]);

  // Project (for the header name/model + the back link).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const projects = await brokk.listProjects();
        if (!alive) return;
        setProject((projectId ? projects.find((x) => x.id === projectId) : projects[0]) ?? null);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  // How many proposed cards (discovery/plan) are waiting in the backlog — drives "Aprovar todos".
  const loadCount = useCallback(async () => {
    if (!projectId) return;
    try {
      const tasks = await brokk.listTasks(projectId);
      setProposedCount(
        tasks.filter(
          (x) => x.status === "backlog" && (x.labels ?? []).some((l) => l === "discovery" || l === "plan"),
        ).length,
      );
    } catch {
      /* ignore */
    }
  }, [projectId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = await discovery.get(projectId);
      setBrief(r.brief);
      setRunning(r.running || r.brief?.status === "pending");
    } catch {
      /* brief stays as-is */
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    setLoaded(false);
    load();
    loadCount();
  }, [load, loadCount]);

  // Poll while a scout is running (or the brief is pending).
  useEffect(() => {
    if (!running) return;
    const i = setInterval(() => {
      load();
      loadCount();
    }, 4000);
    return () => clearInterval(i);
  }, [running, load, loadCount]);

  async function rescout() {
    if (!projectId) return;
    try {
      await discovery.scout(projectId);
      setRunning(true);
      setBrief((b) => (b ? { ...b, status: "pending" } : b));
    } catch {
      /* ignore */
    }
  }

  // Approve ALL proposed cards at once (backlog → queued).
  async function approveAll() {
    if (!projectId) return;
    setAppBusy(true);
    setGenMsg(null);
    try {
      const { enqueued } = await brokk.approveProposed(projectId);
      await loadCount();
      setGenMsg(
        enqueued ? `${enqueued} card(s) enfileirado(s) — a forja vai começar.` : "Nada proposto para aprovar.",
      );
    } catch (e) {
      setGenMsg(`Erro: ${String(e)}`);
    } finally {
      setAppBusy(false);
    }
  }

  // Materialize the brief's "missing" items as proposed backlog cards. They land in
  // the Backlog column on the Quadro; approve each with "queue →" or "Aprovar todos".
  async function generateBacklog() {
    if (!projectId || !brief) return;
    setGenBusy(true);
    setGenMsg(null);
    try {
      const { created, skipped } = await brokk.backlogFromBrief(projectId);
      await loadCount();
      setGenMsg(
        created.length
          ? `${created.length} card${created.length > 1 ? "s" : ""} no backlog${skipped ? ` · ${skipped} já existiam` : ""} — aprove abaixo ou no Quadro.`
          : skipped
            ? `Todos os ${skipped} itens já viraram cards.`
            : "Nada para gerar.",
      );
    } catch (e) {
      setGenMsg(`Erro: ${String(e)}`);
    } finally {
      setGenBusy(false);
    }
  }

  const status = running ? "pending" : brief?.status;

  return (
    <Main style={{ maxWidth: "72rem" }}>
      <PageHeader
        title={project ? project.name : "Descoberta"}
        description={
          <>
            🪶 Huginn — descoberta do projeto.{" "}
            {status === "pending" && <span className="ygg-dim">explorando o repositório…</span>}
            {status === "failed" && <span style={{ color: "var(--err, #f85149)" }}>falhou</span>}
          </>
        }
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {proposedCount > 0 && (
              <Button type="button" size="sm" onClick={approveAll} disabled={appBusy}>
                {appBusy ? "Enfileirando…" : `Aprovar todos (${proposedCount})`}
              </Button>
            )}
            <Button variant="outline" size="sm" type="button" onClick={rescout} disabled={status === "pending"}>
              {status === "pending" ? "escaneando…" : brief ? "Re-escanear" : "Escanear"}
            </Button>
          </div>
        }
      >
        <Link
          href={projectId ? `/projects/${projectId}` : "/"}
          className="ygg-dim"
          style={{ fontSize: 12, textDecoration: "none", display: "inline-block", marginBottom: 6 }}
        >
          ← Quadro
        </Link>
      </PageHeader>

      {!loaded && <p className="ygg-dim" style={{ fontSize: 13 }}>carregando…</p>}

      {loaded && !brief && status !== "pending" && (
        <Banner tone="info">
          Ainda não escaneado. Clique em “Escanear” para o Huginn ler o projeto e propor um backlog.
        </Banner>
      )}

      {status === "failed" && brief?.error && (
        <Banner tone="err">⚠ {brief.error}</Banner>
      )}

      {brief?.status === "ready" && (
        <section style={panel}>
          <div style={{ display: "grid", gap: 16 }}>
            {brief.mission && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>{brief.mission}</p>}
            {brief.summary && (
              <p className="ygg-dim" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>{brief.summary}</p>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
              <BriefList title="✅ Construído" items={brief.built} />
              <BriefList title="🧭 Faltando / próximos passos" items={brief.missing} accent />
            </div>
            {brief.stack.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span className="ygg-dim" style={{ fontSize: 12 }}>stack:</span>
                {brief.stack.map((s) => (
                  <span key={s} style={stackChip}>{s}</span>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Button type="button" size="sm" onClick={generateBacklog} disabled={genBusy || brief.missing.length === 0}>
                {genBusy ? "Gerando…" : `Gerar cards do backlog (${brief.missing.length})`}
              </Button>
              {genMsg && <span className="ygg-dim" style={{ fontSize: 12 }}>{genMsg}</span>}
            </div>
          </div>
        </section>
      )}
    </Main>
  );
}

function BriefList({ title, items, accent }: { title: string; items: string[]; accent?: boolean }) {
  return (
    <div>
      <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--fg-dim)", margin: "0 0 8px" }}>
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="ygg-dim" style={{ fontSize: 12, margin: 0 }}>—</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {items.map((it, i) => (
            <li
              key={i}
              style={{
                fontSize: 13,
                lineHeight: 1.4,
                padding: "6px 9px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                borderLeft: `3px solid ${accent ? "var(--info, #2f81f7)" : "var(--ok, #2ea043)"}`,
                background: "var(--bg-subtle, rgba(127,127,127,0.04))",
              }}
            >
              {it}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const panel: React.CSSProperties = { background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: 18 };
const stackChip: React.CSSProperties = { fontSize: 11, padding: "2px 8px", borderRadius: 999, border: `1px solid ${t.border}`, color: t.textMuted };
