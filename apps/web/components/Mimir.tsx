"use client";

import type {
  ForcaLevel,
  MimirEnhanceResult,
  MimirMode,
  MimirPrompt,
  MimirTriageResult,
  RefinoLevel,
} from "@brokk/sdk";
import { useEffect, useState } from "react";
import {
  Main,
  PageHeader,
  Section,
  Banner,
  Button,
  Input,
  Textarea,
  EmptyState,
} from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";

const MODES: { mode: MimirMode; label: string; hint: string }[] = [
  { mode: "polish", label: "Leve", hint: "Só clareza/gramática" },
  { mode: "structure", label: "Médio", hint: "Contexto → tarefa → saída" },
  { mode: "engineer", label: "Forte", hint: "Arquétipo completo" },
];

const REFINO_LABEL: Record<RefinoLevel, string> = {
  none: "Já está claro",
  polish: "Leve",
  structure: "Médio",
  engineer: "Forte (arquétipo)",
};

const FORCA_LABEL: Record<ForcaLevel, string> = {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
  extra: "Extra",
};

const FORCA_COLOR: Record<ForcaLevel, string> = {
  low: "#2ea043",
  medium: "#d29922",
  high: "#f0883e",
  extra: "#f85149",
};

/** Refino "none" maps to no enhancer mode; the rest map 1:1 onto MimirMode. */
function refinoToMode(refino: RefinoLevel): MimirMode {
  return refino === "none" ? "polish" : refino;
}

export default function Mimir() {
  const [mounted, setMounted] = useState(false);
  const [input, setInput] = useState("");
  const [triage, setTriage] = useState<MimirTriageResult | null>(null);
  const [mode, setMode] = useState<MimirMode>("structure");
  const [result, setResult] = useState<MimirEnhanceResult | null>(null);
  const [busyT, setBusyT] = useState(false);
  const [busyE, setBusyE] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [bank, setBank] = useState<MimirPrompt[]>([]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");

  const refreshBank = async (q?: string) => {
    const rows = q && q.trim() ? await brokk.searchMimirPrompts(q) : await brokk.listMimirPrompts();
    setBank(rows);
  };

  useEffect(() => {
    setMounted(true);
    refreshBank().catch((e) => setErr(String(e)));
  }, []);

  if (!mounted) return null;

  async function doTriage() {
    setBusyT(true);
    setErr(null);
    try {
      const t = await brokk.triagePrompt(input.trim());
      setTriage(t);
      setMode(refinoToMode(t.refino));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyT(false);
    }
  }

  async function doEnhance() {
    setBusyE(true);
    setErr(null);
    try {
      const r = await brokk.enhancePrompt({
        input: input.trim(),
        mode,
        triage: triage ? { ...triage, source: mode === refinoToMode(triage.refino) ? "auto" : "override" } : undefined,
      });
      setResult(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyE(false);
    }
  }

  async function doSave() {
    if (!result) return;
    setErr(null);
    try {
      await brokk.createMimirPrompt({
        title: title.trim() || input.trim().slice(0, 60),
        body: result.enhanced,
        tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setSaving(false);
      setTitle("");
      setTags("");
      await refreshBank(query);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function doDelete(id: string) {
    try {
      await brokk.deleteMimirPrompt(id);
      await refreshBank(query);
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <Main style={{ maxWidth: "58rem" }}>
      <PageHeader
        title="Mímir"
        description={
          <>
            O conselheiro da forja: triagem em dois eixos + refino.{" "}
            <strong>Mímir aconselha → Brokkr forja → Eitri revisa.</strong>
          </>
        }
      />

      {err && <Banner tone="err">⚠ {err}</Banner>}

      {/* ── Intake ── */}
      <div className="ygg-card" style={{ animation: "none" }}>
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Cole a tarefa ou prompt cru…"
          rows={5}
          style={{ resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Button variant="outline" size="sm" onClick={doTriage} disabled={busyT || !input.trim()}>
            {busyT ? "Triando…" : "✦ Triar"}
          </Button>

          <div style={{ display: "flex", gap: 4 }}>
            {MODES.map((m) => (
              <Button
                key={m.mode}
                variant={mode === m.mode ? "default" : "outline"}
                size="sm"
                onClick={() => setMode(m.mode)}
                title={m.hint}
              >
                {m.label}
              </Button>
            ))}
          </div>

          <Button size="sm" onClick={doEnhance} disabled={busyE || !input.trim()}>
            {busyE ? "Refinando…" : "Refinar"}
          </Button>
        </div>

        {triage && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap", paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <span className="ygg-badge" data-tone="info">refino: {REFINO_LABEL[triage.refino]}</span>
            <span className="ygg-badge" style={{ color: FORCA_COLOR[triage.forca], borderColor: FORCA_COLOR[triage.forca] }}>
              força: {FORCA_LABEL[triage.forca]}
            </span>
            <span className="ygg-muted" style={{ fontSize: 12.5, flex: 1, minWidth: 200 }}>{triage.rationale}</span>
          </div>
        )}
      </div>

      {/* ── Result ── */}
      {result && (
        <div className="ygg-card" style={{ animation: "none", marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span className="ygg-dim" style={{ fontSize: 12 }}>
              refinado · {result.mode} · {result.model}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(result.enhanced)}>Copiar</Button>
              <Button size="sm" onClick={() => setSaving((v) => !v)}>Salvar no banco</Button>
            </div>
          </div>
          <pre style={pre}>{result.enhanced}</pre>
          {result.rationale && (
            <p className="ygg-muted" style={{ margin: "10px 0 0", fontSize: 12.5 }}>
              <strong style={{ color: "var(--fg)" }}>O que melhorou:</strong> {result.rationale}
            </p>
          )}
          {saving && (
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título" style={{ flex: "0 1 220px", minWidth: 120 }} />
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, separadas, por, vírgula" style={{ flex: "0 1 260px", minWidth: 120 }} />
              <Button size="sm" onClick={doSave}>Salvar</Button>
            </div>
          )}
        </div>
      )}

      {/* ── Bank ── */}
      <Section title="Banco de prompts" style={{ marginTop: "1.6rem" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              refreshBank(e.target.value).catch((er) => setErr(String(er)));
            }}
            placeholder="Buscar…"
            style={{ flex: "0 1 220px", minWidth: 120 }}
          />
        </div>

        {bank.length === 0 ? (
          <EmptyState
            title="Banco vazio"
            description="Nenhum prompt salvo ainda. Refine um prompt acima e salve no banco."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {bank.map((p) => (
              <div key={p.id} className="ygg-card" style={{ animation: "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600 }}>{p.title}</div>
                    {p.tags.length > 0 && (
                      <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                        {p.tags.map((tag) => (
                          <span key={tag} className="ygg-badge">{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <Button variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(p.body)}>Copiar</Button>
                    <Button variant="destructive" size="sm" onClick={() => doDelete(p.id)}>Excluir</Button>
                  </div>
                </div>
                <pre style={{ ...pre, marginTop: 10, maxHeight: 140, overflow: "auto" }}>{p.body}</pre>
              </div>
            ))}
          </div>
        )}
      </Section>
    </Main>
  );
}

const pre: React.CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: 12.5,
  lineHeight: 1.55,
  color: "var(--fg)",
  background: "var(--bg)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  padding: 12,
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
};
