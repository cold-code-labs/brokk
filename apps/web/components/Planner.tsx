"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR PLANNER — the new front door of the forge. One prompt → Mímir plans it
// (atomic card or feature DAG) → you review/edit → forge: the cards are created
// and compose into ONE PR. This is the UI for the trio's first step.
// ─────────────────────────────────────────────────────────────────────────────

import type React from "react";
import { useEffect, useState } from "react";
import {
  Main,
  PageHeader,
  Section,
  Banner,
  Button,
  Stepper,
  Step,
  type StepState,
} from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { STATUS_COLOR } from "../lib/theme";
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

  // ── Linear flow → Stepper state. Intent → review/clarify the plan → forged. ──
  const stepState = (target: "intent" | "plan" | "forge"): StepState => {
    if (applied) return target === "forge" ? "done" : "done";
    if (draft) return target === "intent" ? "done" : target === "plan" ? "active" : "pending";
    return target === "intent" ? "active" : "pending";
  };

  return (
    <Main style={{ maxWidth: "57.5rem" }}>
      <PageHeader
        title="✦ Planejador"
        description={
          <>
            Descreva a intenção. Mímir decide se é um card só ou uma feature em vários cards —
            e cada card forja no modelo certo, compondo <strong>um único PR</strong>.
          </>
        }
      />

      <Stepper style={{ gridAutoFlow: "column", gridAutoColumns: "max-content", marginBottom: "1.75rem" }}>
        <Step state={stepState("intent")} marker="1">Intenção</Step>
        <Step state={stepState("plan")} marker="2">Plano de Mímir</Step>
        <Step state={stepState("forge")} marker="3">Forjar → PR</Step>
      </Stepper>

      {/* ── Intent ── */}
      <div className="ygg-card" style={{ animation: "none", marginBottom: "0.75rem" }}>
        <div style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "center" }}>
          <label className="ygg-dim" style={{ fontSize: 12 }}>Projeto</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ ...field, fontSize: 12 }}>
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
          style={textareaField}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <Button onClick={generate} disabled={planning || !input.trim()}>
            {planning ? "Planejando…" : "Gerar plano"}
          </Button>
        </div>
      </div>

      {error ? <Banner tone="err">⚠ {error}</Banner> : null}

      {applied ? (
        <Banner tone="info">
          <div style={{ fontWeight: 600 }}>
            ✓ Plano forjando — {applied.count} card{applied.count > 1 ? "s" : ""} na fila
          </div>
          <div style={{ marginTop: 4 }}>
            {applied.plan.summary} · branch <code>{applied.plan.featureBranch}</code> → {applied.plan.baseBranch}
          </div>
        </Banner>
      ) : null}

      {/* ── The plan ── */}
      {draft ? (
        <Section title="Plano de Mímir">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span className="ygg-badge" data-tone={draft.mode === "feature" ? "info" : undefined}>
              {draft.mode === "feature" ? "FEATURE" : "ATOMIC"}
            </span>
            <strong style={{ fontSize: 15 }}>{draft.summary}</strong>
            <span className="ygg-dim" style={{ fontSize: 12, marginLeft: "auto" }}>
              planejado por {draft.model}
            </span>
          </div>
          {draft.rationale ? (
            <p className="ygg-muted" style={{ fontSize: 13, margin: "0 0 14px" }}>{draft.rationale}</p>
          ) : null}

          {draft.questions.length > 0 ? (
            <div className="ygg-card" style={{ animation: "none", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 14, color: "var(--warn)" }}>✦</span>
                <strong style={{ fontSize: 13.5, color: "var(--warn)" }}>
                  Mímir tem {draft.questions.length} dúvida{draft.questions.length > 1 ? "s" : ""} antes de firmar o plano
                </strong>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {draft.questions.map((q) => (
                  <div key={q.id}>
                    <div style={{ fontSize: 13.5, color: "var(--fg)", marginBottom: 2 }}>{q.question}</div>
                    {q.why ? (
                      <div className="ygg-dim" style={{ fontSize: 12, marginBottom: 7 }}>{q.why}</div>
                    ) : null}
                    <input
                      value={answers[q.id] ?? ""}
                      onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                      placeholder="Sua resposta…"
                      style={{ ...field, width: "100%", boxSizing: "border-box" }}
                    />
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                <Button
                  onClick={answerAndReplan}
                  disabled={replanning || !draft.questions.some(hasAnswer)}
                >
                  {replanning ? "Re-planejando…" : "Responder e re-planejar"}
                </Button>
              </div>
            </div>
          ) : null}

          {draft.questions.length > 0 ? (
            <p className="ygg-dim" style={{ fontSize: 12, margin: "0 0 8px" }}>
              Plano provisório (melhor palpite). Responda as dúvidas acima para firmá-lo — ou forje assim mesmo.
            </p>
          ) : null}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {draft.cards.map((c, i) => (
              <div key={i} className="ygg-card" style={{ animation: "none", padding: 12 }}>
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
                    style={{ ...field, fontSize: 12, color: FORCA_COLOR[c.forca] }}
                  >
                    {FORCAS.map((f) => (
                      <option key={f} value={f} style={{ color: "var(--fg)" }}>{f}</option>
                    ))}
                  </select>
                  <span className="ygg-dim" style={{ fontSize: 11, minWidth: 48 }}>{c.model}</span>
                  <Button variant="ghost" size="icon" onClick={() => removeCard(i)} title="remover card">✕</Button>
                </div>
                <textarea
                  value={c.body}
                  onChange={(e) => patchCard(i, { body: e.target.value })}
                  rows={3}
                  style={{ ...textareaField, fontSize: 12.5 }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                  <span className="ygg-dim" style={{ fontSize: 11, minWidth: 70 }} title="Condição de sucesso — o Brokk forja um teste que prova isto">
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
                    <span key={d} className="ygg-badge">↳ {d}</span>
                  ))}
                  {c.touches.map((tch) => (
                    <span key={tch} className="ygg-badge" style={{ borderStyle: "dashed" }}>{tch}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14 }}>
            <Button variant="outline" onClick={() => setDraft(null)}>Descartar</Button>
            <Button onClick={forge} disabled={applying || draft.cards.length === 0}>
              {applying ? "Forjando…" : `Forjar ${draft.cards.length} card${draft.cards.length > 1 ? "s" : ""} → 1 PR`}
            </Button>
          </div>
        </Section>
      ) : null}

      {/* ── Recent plans ── */}
      {recent.length > 0 && !draft ? (
        <Section title="Planos recentes">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recent.slice(0, 12).map((p) => (
              <div key={p.id} className="ygg-card" style={{ ...recentRow, animation: "none" }}>
                <span style={{ ...dot, background: STATUS_COLOR[p.status] ?? "var(--fg-dim)" }} />
                <span style={{ fontSize: 13, color: "var(--fg)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.summary}</span>
                <span className="ygg-badge" data-tone={p.mode === "feature" ? "info" : undefined}>{p.mode}</span>
                <span className="ygg-dim" style={{ fontSize: 11 }}>{p.status}</span>
                {p.prUrl ? (
                  <a href={p.prUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none" }}>PR ↗</a>
                ) : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </Main>
  );
}

const field: React.CSSProperties = {
  background: "var(--bg-soft)",
  border: "1px solid var(--line)",
  borderRadius: "0.55rem",
  padding: "0.55rem 0.7rem",
  color: "var(--fg)",
  font: "inherit",
};
const textareaField: React.CSSProperties = {
  ...field,
  width: "100%",
  fontSize: 13.5,
  resize: "vertical",
  boxSizing: "border-box",
};
const titleInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "transparent",
  border: "none",
  color: "var(--fg)",
  fontSize: 13.5,
  fontWeight: 600,
  outline: "none",
};
const keyChip: React.CSSProperties = {
  fontSize: 11,
  color: "var(--accent)",
  background: "var(--bg-soft)",
  border: "1px solid var(--line)",
  borderRadius: 6,
  padding: "2px 7px",
};
const recentRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
};
const dot: React.CSSProperties = { width: 8, height: 8, borderRadius: 4, flexShrink: 0 };
