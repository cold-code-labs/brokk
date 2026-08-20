"use client";

/**
 * Mission = ops list of Regin missions (legacy). AO surface is Chat OpenCode
 * Plan → lock → Forge (ADR 0073/0074). This page is not a custom Mission UI.
 */

import Link from "next/link";
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { Crosshair, Loader2, MessageSquare, Play, XCircle } from "lucide-react";
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
      });
      setGoal("");
      toast("Mission started — Regin is planning", { tone: "ok" });
      await refresh();
      await openMission(mission.id);
    } catch (e) {
      setErr(String(e));
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
      setErr(String(e));
    }
  }

  return (
    <Main className="forge-page">
      <header className="forge-page-head">
        <h1 className="forge-title">
          <Crosshair size={22} strokeWidth={1.75} aria-hidden /> Missions
        </h1>
        <p className="forge-lede">
          Prefer{" "}
          <Link href="/chat" className="forge-inline-link">
            Chat → Plan → Forge
          </Link>{" "}
          (OpenCode). This page lists Regin org missions only — not a custom AO Mission UI.
        </p>
        <p style={{ marginTop: "0.75rem" }}>
          <Link href="/chat" className="forge-inline-link">
            <MessageSquare size={16} aria-hidden style={{ verticalAlign: "middle" }} /> Open Chat
            (Plan / Build)
          </Link>
        </p>
      </header>

      {err ? <Banner tone="err">{err}</Banner> : null}

      <section className="forge-section" aria-label="Start Regin mission">
        <h2 className="forge-subtitle">Regin mission (ops)</h2>
        <Textarea
          value={goal}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setGoal(e.target.value)}
          placeholder="Goal for Regin planner…"
          rows={3}
          disabled={!projectId || busy}
        />
        <div style={{ marginTop: "0.75rem" }}>
          <Button onClick={() => void startMission()} disabled={busy || !goal.trim()}>
            {busy ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />}
            Start Regin mission
          </Button>
        </div>
      </section>

      <section className="forge-section" aria-label="Missions">
        <h2 className="forge-subtitle">Recent</h2>
        {list.length === 0 ? (
          <p className="forge-muted">No missions yet.</p>
        ) : (
          <ul className="forge-list">
            {list.map((m) => (
              <li key={m.id} className="forge-list-row">
                <button type="button" className="forge-list-main" onClick={() => void openMission(m.id)}>
                  <strong>{m.status}</strong> — {m.goal.slice(0, 120)}
                </button>
                {m.status === "running" || m.status === "planning" ? (
                  <button
                    type="button"
                    className="forge-icon-btn"
                    aria-label="Cancel"
                    onClick={() => void cancelMission(m.id)}
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
          <ul>
            {selected.cards.map((c) => (
              <li key={c.id}>
                {c.status}: {c.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Main>
  );
}
