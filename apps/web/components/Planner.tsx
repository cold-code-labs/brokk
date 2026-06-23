"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR PLANNER — the new front door of the forge. One prompt → Mímir plans it
// (atomic card or feature DAG) → you review/edit → forge: the cards are created
// and compose into ONE PR. This is the UI for the trio's first step.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { brokk } from "../lib/api";
import { STATUS_COLOR, t } from "../lib/theme";
import type { Plan, PlanDraft, PlannedCard, Project } from "@brokk/sdk";

const FORCA_MODEL: Record<string, string> = {
  low: "haiku",
  medium: "sonnet",
  high: "sonnet",
  extra: "opus",
};
const FORCA_COLOR: Record<string, string> = {
  low: "#2ea043",
  medium: "#2f81f7",
  high: "#d2a000",
  extra: "#f85149",
};
const FORCAS = ["low", "medium", "high", "extra"] as const;

export default function Planner() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [input, setInput] = useState("");
  const [planning, setPlanning] = useState(false);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<{ plan: Plan; count: number } | null>(null);
  const [recent, setRecent] = useState<Plan[]>([]);
  // Answers to Mímir's clarifying questions, keyed by question id; folded back
  // into the prompt on re-plan.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [replanning, setReplanning] = useState(false);

  useEffect(() => {
    brokk.listProjects().then((p) => {
      setProjects(p);
      if (p[0]) setProjectId((cur) => cur || p[0].id);
    }).catch(() => {});
    brokk.listPlans().then(setRecent).catch(() => {});
  }, []);

  async function generate() {
    setError("");
    setApplied(null);
    setDraft(null);
    setAnswers({});
    setPlanning(true);
    try {
      const d = await brokk.planJob(input, projectId || undefined);
      setDraft(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  }

  const hasAnswer = (q: { id: string }) => Boolean((answers[q.id] ?? "").trim());

  // Fold the answered questions back into the prompt and re-plan — the clarify
  // loop. The grounded answers become part of the stored intent on forge.
  async function answerAndReplan() {
    if (!draft) return;
    const answered = draft.questions.filter(hasAnswer);
    if (answered.length === 0) return;
    const appendix =
      "\n\n--- Respostas às dúvidas de Mímir ---\n" +
      answered.map((q) => `• ${q.question}\n  → ${(answers[q.id] ?? "").trim()}`).join("\n");
    const grounded = `${input.trim()}${appendix}`;
    setReplanning(true);
    setError("");
    try {
      const d = await brokk.planJob(grounded, projectId || undefined);
      setInput(grounded);
      setAnswers({});
      setDraft(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReplanning(false);
    }
  }

  function patchCard(i: number, patch: Partial<PlannedCard>) {
    if (!draft) return;
    const cards = draft.cards.map((c, j) => (j === i ? { ...c, ...patch } : c));
    setDraft({ ...draft, cards });
  }
  function removeCard(i: number) {
    if (!draft) return;
    setDraft({ ...draft, cards: draft.cards.filter((_, j) => j !== i) });
  }

  async function forge() {
    if (!draft || !projectId) return;
    setApplying(true);
    setError("");
    try {
      const res = await brokk.applyPlan({ input, projectId, plan: draft });
      setApplied({ plan: res.plan, count: res.tasks.length });
      setDraft(null);
      setInput("");
      brokk.listPlans().then(setRecent).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div style={{ padding: "28px 32px", maxWidth: 920, margin: "0 auto" }}>
      <header style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.4, margin: 0 }}>
          ✦ Planejador
        </h1>
        <p style={{ color: t.textMuted, fontSize: 13.5, margin: "6px 0 0" }}>
          Descreva a intenção. Mímir decide se é um card só ou uma feature em vários cards —
          e cada card forja no modelo certo, compondo <strong>um único PR</strong>.
        </p>
      </header>

      {/* ── Intent ── */}
      <div style={card}>
        <div style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "center" }}>
          <label style={{ fontSize: 12, color: t.textMuted }}>Projeto</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={select}>
            {projects.length === 0 ? <option value="">(nenhum projeto)</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ex.: Adicione autenticação por convite: schema de convites, endpoint de aceitar, e a tela de onboarding."
          rows={4}
          style={textarea}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <button onClick={generate} disabled={planning || !input.trim()} style={btnPrimary(planning || !input.trim())}>
            {planning ? "Planejando…" : "Gerar plano"}
          </button>
        </div>
      </div>

      {error ? (
        <div style={{ ...card, borderColor: "#5c2626", color: "#f85149", fontSize: 13 }}>{error}</div>
      ) : null}

      {applied ? (
        <div style={{ ...card, borderColor: "#1f4d2b" }}>
          <div style={{ color: "#2ea043", fontWeight: 600, fontSize: 14 }}>
            ✓ Plano forjando — {applied.count} card{applied.count > 1 ? "s" : ""} na fila
          </div>
          <div style={{ color: t.textMuted, fontSize: 13, marginTop: 4 }}>
            {applied.plan.summary} · branch <code>{applied.plan.featureBranch}</code> → {applied.plan.baseBranch}
          </div>
        </div>
      ) : null}

      {/* ── The plan ── */}
      {draft ? (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={badge(draft.mode === "feature" ? t.purple : t.accent)}>
              {draft.mode === "feature" ? "FEATURE" : "ATOMIC"}
            </span>
            <strong style={{ fontSize: 15 }}>{draft.summary}</strong>
            <span style={{ color: t.textFaint, fontSize: 12, marginLeft: "auto" }}>
              planejado por {draft.model}
            </span>
          </div>
          {draft.rationale ? (
            <p style={{ color: t.textMuted, fontSize: 13, margin: "0 0 14px" }}>{draft.rationale}</p>
          ) : null}

          {draft.questions.length > 0 ? (
            <div style={clarifyBox}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 14 }}>✦</span>
                <strong style={{ fontSize: 13.5, color: "#e3b341" }}>
                  Mímir tem {draft.questions.length} dúvida{draft.questions.length > 1 ? "s" : ""} antes de firmar o plano
                </strong>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {draft.questions.map((q) => (
                  <div key={q.id}>
                    <div style={{ fontSize: 13.5, color: t.text, marginBottom: 2 }}>{q.question}</div>
                    {q.why ? (
                      <div style={{ fontSize: 12, color: t.textFaint, marginBottom: 7 }}>{q.why}</div>
                    ) : null}
                    <input
                      value={answers[q.id] ?? ""}
                      onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                      placeholder="Sua resposta…"
                      style={{ ...textarea, padding: "8px 11px" }}
                    />
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                <button
                  onClick={answerAndReplan}
                  disabled={replanning || !draft.questions.some(hasAnswer)}
                  style={btnPrimary(replanning || !draft.questions.some(hasAnswer))}
                >
                  {replanning ? "Re-planejando…" : "Responder e re-planejar"}
                </button>
              </div>
            </div>
          ) : null}

          {draft.questions.length > 0 ? (
            <p style={{ fontSize: 12, color: t.textFaint, margin: "0 0 8px" }}>
              Plano provisório (melhor palpite). Responda as dúvidas acima para firmá-lo — ou forje assim mesmo.
            </p>
          ) : null}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {draft.cards.map((c, i) => (
              <div key={i} style={cardRow}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <code style={keyChip}>{c.key}</code>
                  <input
                    value={c.title}
                    onChange={(e) => patchCard(i, { title: e.target.value })}
                    style={titleInput}
                  />
                  <select
                    value={c.forca}
                    onChange={(e) => patchCard(i, { forca: e.target.value as PlannedCard["forca"], model: FORCA_MODEL[e.target.value] })}
                    style={{ ...select, color: FORCA_COLOR[c.forca] }}
                  >
                    {FORCAS.map((f) => (
                      <option key={f} value={f} style={{ color: t.text }}>{f}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: 11, color: t.textFaint, minWidth: 48 }}>{c.model}</span>
                  <button onClick={() => removeCard(i)} style={btnGhost} title="remover card">✕</button>
                </div>
                <textarea
                  value={c.body}
                  onChange={(e) => patchCard(i, { body: e.target.value })}
                  rows={3}
                  style={{ ...textarea, fontSize: 12.5 }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                  <span style={{ fontSize: 11, color: t.textFaint, minWidth: 70 }} title="Condição de sucesso — o Brokk forja um teste que prova isto">
                    ✓ aceite
                  </span>
                  <input
                    value={c.acceptance ?? ""}
                    onChange={(e) => patchCard(i, { acceptance: e.target.value })}
                    placeholder="condição de sucesso testável (ex.: GET /health → 200)"
                    style={{ ...titleInput, fontSize: 12 }}
                  />
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {c.dependsOn.map((d) => (
                    <span key={d} style={depChip}>↳ {d}</span>
                  ))}
                  {c.touches.map((tch) => (
                    <span key={tch} style={touchChip}>{tch}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14 }}>
            <button onClick={() => setDraft(null)} style={btnGhost2}>Descartar</button>
            <button onClick={forge} disabled={applying || draft.cards.length === 0} style={btnPrimary(applying)}>
              {applying ? "Forjando…" : `Forjar ${draft.cards.length} card${draft.cards.length > 1 ? "s" : ""} → 1 PR`}
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Recent plans ── */}
      {recent.length > 0 && !draft ? (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 13, color: t.textMuted, fontWeight: 600, marginBottom: 10 }}>Planos recentes</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recent.slice(0, 12).map((p) => (
              <div key={p.id} style={recentRow}>
                <span style={{ ...dot, background: STATUS_COLOR[p.status] ?? t.textFaint }} />
                <span style={{ fontSize: 13, color: t.text, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.summary}</span>
                <span style={badge(p.mode === "feature" ? t.purple : t.accent)}>{p.mode}</span>
                <span style={{ fontSize: 11, color: t.textFaint }}>{p.status}</span>
                {p.prUrl ? (
                  <a href={p.prUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: t.accent, textDecoration: "none" }}>PR ↗</a>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const card: React.CSSProperties = {
  background: t.surface,
  border: `1px solid ${t.border}`,
  borderRadius: 12,
  padding: 16,
  marginBottom: 12,
};
const cardRow: React.CSSProperties = {
  background: t.surface2,
  border: `1px solid ${t.border}`,
  borderRadius: 10,
  padding: 12,
};
const clarifyBox: React.CSSProperties = {
  background: "#1a1605",
  border: "1px solid #4d3a00",
  borderRadius: 10,
  padding: 14,
  marginBottom: 14,
};
const recentRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
  background: t.surface,
  border: `1px solid ${t.border}`,
  borderRadius: 9,
};
const textarea: React.CSSProperties = {
  width: "100%",
  background: t.inset,
  border: `1px solid ${t.border2}`,
  borderRadius: 8,
  color: t.text,
  padding: "10px 12px",
  fontSize: 13.5,
  fontFamily: "inherit",
  resize: "vertical",
  boxSizing: "border-box",
};
const titleInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "transparent",
  border: "none",
  color: t.text,
  fontSize: 13.5,
  fontWeight: 600,
  outline: "none",
};
const select: React.CSSProperties = {
  background: t.surface3,
  border: `1px solid ${t.border2}`,
  borderRadius: 7,
  color: t.text,
  padding: "5px 8px",
  fontSize: 12,
};
const keyChip: React.CSSProperties = {
  fontSize: 11,
  color: t.purple,
  background: "#1c1830",
  border: "1px solid #2a2342",
  borderRadius: 6,
  padding: "2px 7px",
};
const depChip: React.CSSProperties = {
  fontSize: 11,
  color: t.textMuted,
  background: t.surface3,
  borderRadius: 6,
  padding: "2px 7px",
};
const touchChip: React.CSSProperties = {
  fontSize: 11,
  color: t.textFaint,
  border: `1px dashed ${t.border2}`,
  borderRadius: 6,
  padding: "2px 7px",
};
const dot: React.CSSProperties = { width: 8, height: 8, borderRadius: 4, flexShrink: 0 };

function badge(color: string): React.CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.5,
    color,
    border: `1px solid ${color}55`,
    borderRadius: 5,
    padding: "1px 6px",
  };
}
function btnPrimary(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? t.surface3 : t.accent,
    color: disabled ? t.textFaint : "#fff",
    border: "none",
    borderRadius: 8,
    padding: "9px 16px",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: disabled ? "default" : "pointer",
  };
}
const btnGhost: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: t.textFaint,
  cursor: "pointer",
  fontSize: 13,
};
const btnGhost2: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${t.border2}`,
  color: t.textMuted,
  borderRadius: 8,
  padding: "9px 16px",
  fontSize: 13.5,
  cursor: "pointer",
};
