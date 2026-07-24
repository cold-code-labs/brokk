"use client";

/**
 * Mission UI skeleton (ADR 0074 Fase 2) — Plan lock surface over Regin.
 * Backend already plans/dispatches via /missions; this is the AO composition:
 * goal → mission → cards + status (preview link later).
 */

import Link from "next/link";
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { Crosshair, Loader2, Play, XCircle } from "lucide-react";
import { Banner, Button, Main, Textarea } from "@cold-code-labs/yggdrasil-react";
import { useProject } from "../lib/project-context";
import { useToast } from "./Toaster";

type MissionRow = {
  id: string;
  projectId: string;
  goal: string;
  status: string;
  detail: string | null;
  autoApprove: boolean;
  createdAt: string;
  updatedAt: string;
};

type MissionCard = {
  id: string;
  title: string;
  status: string;
};

type MissionDetail = {
  mission: MissionRow;
  events: { id: string; type: string; payload: unknown; createdAt: string }[];
  cards: MissionCard[];
};

const API = process.env.NEXT_PUBLIC_BROKK_API_URL || "/api";

async function apiJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `${res.status}`);
  }
  return res.json() as Promise<T>;
}

export default function Mission() {
  const { currentId: projectId } = useProject();
  const toast = useToast();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<MissionRow[]>([]);
  const [selected, setSelected] = useState<MissionDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setList([]);
      return;
    }
    const rows = await apiJson<MissionRow[]>(
      "GET",
      `/missions?projectId=${encodeURIComponent(projectId)}`,
    );
    setList(rows);
  }, [projectId]);

  useEffect(() => {
    void refresh().catch((e) => setErr(String(e)));
    const t = setInterval(() => void refresh().catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function startMission() {
    if (!projectId || !goal.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const mission = await apiJson<MissionRow>("POST", "/missions", {
        projectId,
        goal: goal.trim(),
        autoApprove: true,
      });
      setGoal("");
      toast("Mission started — Regin is planning", { tone: "ok" });
      await refresh();
      await openMission(mission.id);
    } catch (e) {
      setErr(String(e));
      toast("Failed to start mission", { tone: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function openMission(id: string) {
    try {
      const detail = await apiJson<MissionDetail>("GET", `/missions/${id}`);
      setSelected(detail);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function cancelMission(id: string) {
    try {
      await apiJson("POST", `/missions/${id}/cancel`);
      toast("Mission cancelled", { tone: "ok" });
      await refresh();
      if (selected?.mission.id === id) await openMission(id);
    } catch (e) {
      toast(String(e), { tone: "err" });
    }
  }

  return (
    <Main className="forge-page">
      <header className="forge-page-head">
        <p className="forge-crumb">
          <Link href="/fleet">Projects</Link>
          <span aria-hidden> / </span>
          Mission
        </p>
        <h1 className="forge-title">
          <Crosshair size={22} strokeWidth={1.75} aria-hidden /> Mission
        </h1>
        <p className="forge-lead">
          Goal → plan → cards on the Forge. Chat (OpenCode) for interactive; Mission for org-scale
          dispatch.
        </p>
      </header>

      {!projectId ? (
        <Banner tone="warn">Pick a project on the anvil to start a mission.</Banner>
      ) : (
        <section className="forge-section" aria-label="Start mission">
          <Textarea
            value={goal}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setGoal(e.target.value)}
            placeholder="What should Brokk accomplish? (e.g. harden auth, ship the billing fix…)"
            rows={4}
            disabled={busy}
          />
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <Button onClick={() => void startMission()} disabled={busy || !goal.trim()}>
              {busy ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
              Start mission
            </Button>
            <Link href="/chat" className="forge-crumb" style={{ alignSelf: "center" }}>
              Or open Chat
            </Link>
          </div>
        </section>
      )}

      {err ? <Banner tone="err">{err}</Banner> : null}

      <section className="forge-section" aria-label="Missions">
        <h2 className="forge-subtitle">Active & recent</h2>
        {list.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No missions yet for this project.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {list.map((m) => (
              <li
                key={m.id}
                style={{ display: "flex", gap: 8, alignItems: "flex-start", justifyContent: "space-between" }}
              >
                <button
                  type="button"
                  onClick={() => void openMission(m.id)}
                  style={{
                    textAlign: "left",
                    flex: 1,
                    background: "transparent",
                    border: "1px solid var(--border, #333)",
                    borderRadius: 6,
                    padding: "10px 12px",
                    cursor: "pointer",
                    color: "inherit",
                  }}
                >
                  <strong style={{ display: "block", marginBottom: 4 }}>{m.status}</strong>
                  <span>{m.goal.slice(0, 120)}</span>
                </button>
                {m.status !== "done" && m.status !== "failed" && m.status !== "cancelled" ? (
                  <button
                    type="button"
                    aria-label="Cancel mission"
                    onClick={() => void cancelMission(m.id)}
                    style={{ background: "transparent", border: 0, cursor: "pointer", color: "inherit", padding: 8 }}
                  >
                    <XCircle size={16} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected ? (
        <section className="forge-section" aria-label="Mission detail">
          <h2 className="forge-subtitle">Mission · {selected.mission.status}</h2>
          <p>{selected.mission.goal}</p>
          {selected.mission.detail ? <p style={{ opacity: 0.7 }}>{selected.mission.detail}</p> : null}
          <h3 className="forge-subtitle">Cards</h3>
          {selected.cards.length === 0 ? (
            <p style={{ opacity: 0.7 }}>Waiting for plan…</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0 }}>
              {selected.cards.map((c) => (
                <li key={c.id} style={{ marginBottom: 6 }}>
                  <Link href={`/projects/${selected.mission.projectId}`}>{c.title}</Link>
                  <span style={{ opacity: 0.7 }}> · {c.status}</span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="forge-subtitle">Trail</h3>
          <ul style={{ listStyle: "none", padding: 0, opacity: 0.7 }}>
            {selected.events.slice(-12).map((e) => (
              <li key={e.id}>
                {e.type} · {new Date(e.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Main>
  );
}
