"use client";

import { useMemo, useState } from "react";
import type { HouseLifecycle, HouseObjective } from "@brokk/core";
import {
  composeChatBrief,
  composeObjectiveSummary,
  packForProject,
  type InterviewPack,
} from "../lib/house-interview";

export type ObjectivePanelProps = {
  projectId: string;
  projectName: string;
  lifecycle: HouseLifecycle;
  objective: HouseObjective | null;
  busy?: boolean;
  onClose: () => void;
  onSave: (next: {
    houseLifecycle: HouseLifecycle;
    houseObjective: HouseObjective;
    chatBrief: string;
  }) => void | Promise<void>;
  onArchive?: () => void | Promise<void>;
};

export default function ObjectivePanel({
  projectId,
  projectName,
  lifecycle,
  objective,
  busy,
  onClose,
  onSave,
  onArchive,
}: ObjectivePanelProps) {
  const pack = useMemo(() => packForProject(projectName), [projectName]);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(
    () => objective?.answers ?? {},
  );
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");

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

  function applyCustom(qid: string, text: string) {
    setCustom((prev) => ({ ...prev, [qid]: text }));
    if (!text.trim()) return;
    setAnswers((prev) => {
      const q = pack.questions.find((x) => x.id === qid);
      if (q?.multi) {
        const cur = prev[qid];
        const arr = Array.isArray(cur) ? cur.filter((x) => !x.startsWith("custom:")) : [];
        return { ...prev, [qid]: [...arr, `custom:${text.trim()}`] };
      }
      return { ...prev, [qid]: `custom:${text.trim()}` };
    });
  }

  async function lock(as: HouseLifecycle) {
    setErr("");
    const missing = pack.questions.filter((q) => {
      const v = answers[q.id];
      if (v == null) return true;
      if (Array.isArray(v)) return v.length === 0;
      return String(v).trim() === "";
    });
    // Require at least mission/job-like first question + stage/done when present.
    const required = pack.questions.slice(0, Math.min(3, pack.questions.length));
    const need = required.filter((q) => missing.some((m) => m.id === q.id));
    if (need.length) {
      setErr(`Faltam respostas: ${need.map((q) => q.prompt).join(" · ")}`);
      return;
    }
    const summary = composeObjectiveSummary(pack, answers);
    const locked: HouseObjective = {
      summary,
      answers,
      lockedAt: new Date().toISOString(),
      pack: pack.id,
    };
    const chatBrief = composeChatBrief(projectName, pack, answers, summary);
    await onSave({ houseLifecycle: as, houseObjective: locked, chatBrief });
  }

  const needsObjective =
    lifecycle === "undocumented" || !objective?.summary;

  return (
    <aside className="house-obj" aria-label={`Objetivo · ${projectName}`}>
      <header className="house-obj-head">
        <div>
          <span className="house-obj-eyebrow">Objetivo · única etapa humana</span>
          <h2 className="house-obj-title">{projectName}</h2>
          <p className="house-obj-blurb">{pack.blurb}</p>
        </div>
        <button type="button" className="house-ico" aria-label="Fechar" onClick={onClose}>
          ✕
        </button>
      </header>

      {needsObjective ? (
        <p className="house-obj-banner">Sem documentação/objetivo — responda abaixo para destravar.</p>
      ) : (
        <p className="house-obj-banner is-ok">
          Objetivo travado · {lifecycle}
          {objective?.lockedAt ? ` · ${new Date(objective.lockedAt).toLocaleString()}` : ""}
        </p>
      )}

      <div className="house-obj-body">
        {pack.questions.map((q) => (
          <QuestionBlock
            key={q.id}
            pack={pack}
            q={q}
            value={answers[q.id]}
            custom={custom[q.id] ?? ""}
            onSingle={setSingle}
            onMulti={toggleMulti}
            onCustom={applyCustom}
          />
        ))}
      </div>

      {err ? <p className="house-obj-err">{err}</p> : null}

      <footer className="house-obj-foot">
        <button
          type="button"
          className="house-obj-primary"
          disabled={busy}
          onClick={() => void lock("working")}
        >
          Travar objetivo · Trabalhando
        </button>
        <button
          type="button"
          className="house-obj-secondary"
          disabled={busy}
          onClick={() => void lock("prototype")}
        >
          Só protótipo por agora
        </button>
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
        <span className="house-obj-hint" data-project={projectId}>
          Pack {pack.id} · Spec Rails entra depois do lock
        </span>
      </footer>
    </aside>
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
  pack: InterviewPack;
  q: import("../lib/house-interview").InterviewQuestion;
  value: string | string[] | undefined;
  custom: string;
  onSingle: (qid: string, id: string) => void;
  onMulti: (qid: string, id: string) => void;
  onCustom: (qid: string, text: string) => void;
}) {
  const selected = new Set(
    Array.isArray(value) ? value : value ? [String(value)] : [],
  );
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
        <input
          className="house-q-custom"
          value={custom}
          placeholder={q.options?.length ? "Ou digite sua resposta…" : "Sua resposta…"}
          onChange={(e) => onCustom(q.id, e.target.value)}
        />
      ) : null}
    </section>
  );
}
