"use client";

import { useMemo, useState } from "react";
import type { HouseLifecycle, HouseObjective } from "@brokk/core";
import type { Task } from "@brokk/sdk";
import {
  buildMicroQuestions,
  buildRecap,
  composeChatBrief,
  composeObjectiveSummary,
  type InterviewQuestion,
  type ProjectRecap,
} from "../lib/house-interview";

export type ObjectivePanelProps = {
  projectId: string;
  projectName: string;
  lifecycle: HouseLifecycle;
  objective: HouseObjective | null;
  tasks: Task[];
  mission: string | null;
  missing: string[];
  busy?: boolean;
  onClose: () => void;
  onSave: (next: {
    houseLifecycle: HouseLifecycle;
    houseObjective: HouseObjective;
    chatBrief: string;
  }) => void | Promise<void>;
  onArchive?: () => void | Promise<void>;
};

type Phase = "recap" | "next" | "micro";

export default function ObjectivePanel({
  projectId,
  projectName,
  lifecycle,
  objective,
  tasks,
  mission,
  missing,
  busy,
  onClose,
  onSave,
  onArchive,
}: ObjectivePanelProps) {
  const recap = useMemo(
    () => buildRecap({ tasks, mission, missing, objective }),
    [tasks, mission, missing, objective],
  );

  const [phase, setPhase] = useState<Phase>(recap.hasSignal ? "recap" : "next");
  const [nextObjective, setNextObjective] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");

  const microQs = useMemo(
    () =>
      nextObjective.trim()
        ? buildMicroQuestions({ projectName, nextObjective, recap })
        : [],
    [projectName, nextObjective, recap],
  );

  function setSingle(qid: string, optionId: string) {
    setAnswers((prev) => ({ ...prev, [qid]: optionId }));
  }

  function toggleMulti(qid: string, optionId: string) {
    setAnswers((prev) => {
      const cur = prev[qid];
      const arr = Array.isArray(cur) ? [...cur] : cur ? [String(cur)] : [];
      const i = arr.indexOf(optionId);
      if (i >= 0) arr.splice(i, 1);
      else arr.push(optionId);
      return { ...prev, [qid]: arr };
    });
  }

  function applyCustom(qid: string, text: string, multi?: boolean) {
    setCustom((prev) => ({ ...prev, [qid]: text }));
    if (!text.trim()) return;
    setAnswers((prev) => {
      if (multi) {
        const cur = prev[qid];
        const arr = Array.isArray(cur) ? cur.filter((x) => !x.startsWith("custom:")) : [];
        return { ...prev, [qid]: [...arr, `custom:${text.trim()}`] };
      }
      return { ...prev, [qid]: `custom:${text.trim()}` };
    });
  }

  function goMicro() {
    setErr("");
    if (!nextObjective.trim()) {
      setErr("Escreva (ou escolha) o próximo objetivo desta rodada.");
      return;
    }
    setPhase("micro");
  }

  async function lockAndStart() {
    setErr("");
    if (!nextObjective.trim()) {
      setErr("Objetivo vazio.");
      return;
    }
    const stepsText = (custom.micro_steps ?? "").trim()
      || (typeof answers.micro_steps === "string"
        ? answers.micro_steps.replace(/^custom:/, "").trim()
        : Array.isArray(answers.micro_steps)
          ? answers.micro_steps.map((s) => s.replace(/^custom:/, "")).join("\n").trim()
          : "");
    if (!stepsText) {
      setErr("Liste ao menos uma micro-etapa (uma por linha).");
      return;
    }
    const finalAnswers = {
      ...answers,
      micro_steps: `custom:${stepsText}`,
    };
    const summary = composeObjectiveSummary(nextObjective, finalAnswers, microQs);
    const locked: HouseObjective = {
      summary,
      answers: finalAnswers,
      lockedAt: new Date().toISOString(),
      pack: `round:${projectName.toLowerCase().replace(/\s+/g, "-")}`,
    };
    const chatBrief = composeChatBrief({
      projectName,
      nextObjective,
      recap,
      answers: finalAnswers,
      questions: microQs,
      summary,
    });
    await onSave({ houseLifecycle: "working", houseObjective: locked, chatBrief });
  }

  return (
    <aside className="house-obj" aria-label={`Objetivo · ${projectName}`}>
      <header className="house-obj-head">
        <div>
          <span className="house-obj-eyebrow">Rodada · {projectName}</span>
          <h2 className="house-obj-title">
            {phase === "recap" && "O que rolou"}
            {phase === "next" && "Próximo objetivo"}
            {phase === "micro" && "Micro-etapas"}
          </h2>
          <p className="house-obj-blurb">
            Leitura deste projeto — não um formulário genérico. Clique nas opções ou digite.
          </p>
        </div>
        <button type="button" className="house-ico" aria-label="Fechar" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="house-obj-steps" aria-hidden>
        <span className={phase === "recap" ? "is-on" : ""}>1 Recap</span>
        <span className={phase === "next" ? "is-on" : ""}>2 Objetivo</span>
        <span className={phase === "micro" ? "is-on" : ""}>3 Micro</span>
      </div>

      <div className="house-obj-body">
        {phase === "recap" ? <RecapView recap={recap} /> : null}

        {phase === "next" ? (
          <NextObjectiveView
            recap={recap}
            value={nextObjective}
            onChange={setNextObjective}
          />
        ) : null}

        {phase === "micro"
          ? microQs.map((q) => (
              <QuestionBlock
                key={q.id}
                q={q}
                value={answers[q.id]}
                custom={custom[q.id] ?? ""}
                onSingle={setSingle}
                onMulti={toggleMulti}
                onCustom={applyCustom}
              />
            ))
          : null}
      </div>

      {err ? <p className="house-obj-err">{err}</p> : null}

      <footer className="house-obj-foot">
        {phase === "recap" ? (
          <button type="button" className="house-obj-primary" onClick={() => setPhase("next")}>
            Definir próximo objetivo →
          </button>
        ) : null}
        {phase === "next" ? (
          <>
            {recap.hasSignal ? (
              <button type="button" className="house-obj-secondary" onClick={() => setPhase("recap")}>
                ← Voltar ao recap
              </button>
            ) : null}
            <button type="button" className="house-obj-primary" onClick={goMicro}>
              Detalhar micro-etapas →
            </button>
          </>
        ) : null}
        {phase === "micro" ? (
          <>
            <button type="button" className="house-obj-secondary" onClick={() => setPhase("next")}>
              ← Ajustar objetivo
            </button>
            <button
              type="button"
              className="house-obj-primary"
              disabled={busy}
              onClick={() => void lockAndStart()}
            >
              Iniciar trabalho · documentar
            </button>
          </>
        ) : null}
        {onArchive ? (
          <button
            type="button"
            className="house-obj-ghost"
            disabled={busy}
            onClick={() => void onArchive()}
          >
            Arquivar projeto
          </button>
        ) : null}
        <span className="house-obj-hint" data-project={projectId} data-life={lifecycle}>
          Spec Rails + forge entram depois do lock desta rodada
        </span>
      </footer>
    </aside>
  );
}

function RecapView({ recap }: { recap: ProjectRecap }) {
  if (!recap.hasSignal) {
    return (
      <p className="house-obj-banner">
        Sem histórico recente neste projeto — vamos definir o próximo objetivo do zero.
      </p>
    );
  }
  return (
    <div className="house-recap">
      {recap.mission ? (
        <section>
          <h3>Missão (Huginn)</h3>
          <p>{recap.mission}</p>
        </section>
      ) : null}
      {recap.lastObjectiveSummary ? (
        <section>
          <h3>Última rodada travada</h3>
          <pre>{recap.lastObjectiveSummary}</pre>
          {recap.lastLockedAt ? (
            <p className="house-recap-meta">{new Date(recap.lastLockedAt).toLocaleString()}</p>
          ) : null}
        </section>
      ) : null}
      {recap.recentDone.length ? (
        <section>
          <h3>Feito recente</h3>
          <ul>
            {recap.recentDone.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {recap.recentRunning.length || recap.recentReview.length ? (
        <section>
          <h3>Em voo</h3>
          <ul>
            {[...recap.recentRunning, ...recap.recentReview].map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {recap.missing.length ? (
        <section>
          <h3>Gaps visíveis</h3>
          <ul>
            {recap.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function NextObjectiveView({
  recap,
  value,
  onChange,
}: {
  recap: ProjectRecap;
  value: string;
  onChange: (v: string) => void;
}) {
  const suggestions = [
    ...recap.missing.slice(0, 4),
    ...(recap.recentReview[0] ? [`Destravar review: ${recap.recentReview[0]}`] : []),
  ];
  return (
    <div className="house-next">
      <p className="house-obj-banner">
        Qual o próximo objetivo desta rodada? Depois quebramos em micro-etapas.
      </p>
      <textarea
        className="house-next-input"
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Ex.: Tela de gestão de usuários com RBAC e arquivar contato…"
      />
      {suggestions.length ? (
        <div className="house-q-opts">
          <p className="house-recap-meta">Sugestões a partir deste projeto:</p>
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className={`house-q-opt${value === s ? " is-on" : ""}`}
              onClick={() => onChange(s)}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QuestionBlock({
  q,
  value,
  custom,
  onSingle,
  onMulti,
  onCustom,
}: {
  q: InterviewQuestion;
  value: string | string[] | undefined;
  custom: string;
  onSingle: (qid: string, id: string) => void;
  onMulti: (qid: string, id: string) => void;
  onCustom: (qid: string, text: string, multi?: boolean) => void;
}) {
  const selected = new Set(Array.isArray(value) ? value : value ? [String(value)] : []);
  const isSteps = q.id === "micro_steps";
  return (
    <section className="house-q">
      <h3 className="house-q-prompt">{q.prompt}</h3>
      {q.options?.length ? (
        <div className="house-q-opts">
          {q.options.map((o) => {
            const on = selected.has(o.id);
            return (
              <button
                key={o.id}
                type="button"
                className={`house-q-opt${on ? " is-on" : ""}`}
                onClick={() => (q.multi ? onMulti(q.id, o.id) : onSingle(q.id, o.id))}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      ) : null}
      {q.allowCustom || !q.options?.length ? (
        isSteps ? (
          <textarea
            className="house-next-input"
            rows={5}
            value={custom}
            placeholder={"1. …\n2. …\n3. …"}
            onChange={(e) => onCustom(q.id, e.target.value, false)}
          />
        ) : (
          <input
            className="house-q-custom"
            value={custom}
            placeholder={q.options?.length ? "Ou digite sua resposta…" : "Sua resposta…"}
            onChange={(e) => onCustom(q.id, e.target.value, q.multi)}
          />
        )
      ) : null}
    </section>
  );
}
