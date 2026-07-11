"use client";

import type { Project } from "@brokk/sdk";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Bird } from "lucide-react";
import { Main, Banner, Button } from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { discovery, type ProjectBrief } from "../lib/chat";
import { useProject } from "../lib/project-context";

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

  // How many proposed cards (discovery/plan) are waiting in the backlog — drives "Approve N".
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
        enqueued ? `${enqueued} card${enqueued === 1 ? "" : "s"} queued — to the forge.` : "Nothing proposed.",
      );
    } catch (e) {
      setGenMsg(`Could not queue — ${String(e)}`);
    } finally {
      setAppBusy(false);
    }
  }

  // Materialize the brief's "missing" items as proposed backlog cards. They land in
  // the Backlog column on the Quadro; approve each with "queue →" or "Approve N".
  async function generateBacklog() {
    if (!projectId || !brief) return;
    setGenBusy(true);
    setGenMsg(null);
    try {
      const { created, skipped } = await brokk.backlogFromBrief(projectId);
      await loadCount();
      setGenMsg(
        created.length
          ? `${created.length} card${created.length > 1 ? "s" : ""} in the backlog${skipped ? ` · ${skipped} already existed` : ""}. Approve here or on the board.`
          : skipped
            ? `All ${skipped} items already have cards.`
            : "Nothing to create.",
      );
    } catch (e) {
      setGenMsg(`Could not create cards — ${String(e)}`);
    } finally {
      setGenBusy(false);
    }
  }

  const status = running ? "pending" : brief?.status;

  return (
    <Main style={{ maxWidth: "72rem" }}>
      {/* ── masthead: the scout ── */}
      <header className="forge-head">
        <div className="forge-head-top">
          <div>
            <div style={{ marginBottom: 6 }}>
              <Link
                href={projectId ? `/projects/${projectId}` : "/"}
                className="ygg-dim"
                style={{ fontSize: 12, textDecoration: "none" }}
              >
                ← Board
              </Link>
            </div>
            <span className="forge-eyebrow">Brokk · the scout</span>
            <h1 className="forge-title">{project ? project.name : "Discovery"}</h1>
            <p className="forge-sub">
              Huginn reads the repo and returns the brief — mission, built, missing, stack.
            </p>
            {status === "pending" && (
              <span className="forge-pulse" style={{ marginTop: "0.8rem" }}>
                <span className="forge-ember" />
                Scouting…
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {proposedCount > 0 && (
              <Button type="button" size="sm" onClick={approveAll} disabled={appBusy}>
                {appBusy ? "Queueing…" : `Approve ${proposedCount}`}
              </Button>
            )}
            <Button variant="outline" size="sm" type="button" onClick={rescout} disabled={status === "pending"}>
              {status === "pending" ? "Scouting…" : brief ? "Scout again" : "Scout"}
            </Button>
          </div>
        </div>
        <div className="forge-head-rule" />
      </header>

      {!loaded && <p className="ygg-dim" style={{ fontSize: 13 }}>Loading…</p>}

      {loaded && !brief && status !== "pending" && (
        <div className="forge-empty is-panel">
          <span className="forge-empty-mark"><Bird /></span>
          <span className="forge-empty-title">Not yet scouted</span>
          <p className="forge-empty-sub">
            One pass writes the brief and proposes backlog cards from what is missing.
          </p>
          <span className="forge-empty-action">
            <Button type="button" onClick={rescout}>Scout</Button>
          </span>
        </div>
      )}

      {status === "failed" && brief?.error && (
        <Banner tone="err">Scout failed — {brief.error}. Scout again to retry.</Banner>
      )}

      {brief?.status === "ready" && (
        <section className="forge-panel">
          <div style={{ display: "grid", gap: 16 }}>
            {brief.mission && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: "var(--fg)" }}>{brief.mission}</p>}
            {brief.summary && (
              <p className="ygg-muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>{brief.summary}</p>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
              <BriefList title="Built" items={brief.built} />
              <BriefList title="Missing" items={brief.missing} accent />
            </div>
            {brief.stack.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span className="forge-h-title">Stack</span>
                {brief.stack.map((s) => (
                  <span key={s} className="forge-chip">{s}</span>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Button type="button" size="sm" onClick={generateBacklog} disabled={genBusy || brief.missing.length === 0}>
                {genBusy ? "Creating…" : `Create ${brief.missing.length} card${brief.missing.length === 1 ? "" : "s"}`}
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
      <div className="forge-h" style={{ marginBottom: "0.6rem" }}>
        <span className="forge-h-title">{title}</span>
        <span className="forge-h-meta">{items.length}</span>
        <span className="forge-h-rule" />
      </div>
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
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--line)",
                borderLeft: `3px solid ${accent ? "var(--accent)" : "var(--ok)"}`,
                background: "color-mix(in srgb, var(--fg) 3%, transparent)",
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
