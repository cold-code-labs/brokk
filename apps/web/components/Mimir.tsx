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
import { brokk } from "../lib/api";
import { t as theme } from "../lib/theme";

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
    <div style={{ padding: "28px 32px", maxWidth: 920 }}>
      <h1 style={{ margin: 0, fontSize: 22, letterSpacing: -0.4 }}>Mímir</h1>
      <p style={{ margin: "4px 0 22px", color: theme.textMuted, fontSize: 14 }}>
        O conselheiro da forja: triagem em dois eixos + refino. <strong>Mímir aconselha → Brokkr forja → Eitri revisa.</strong>
      </p>

      {err && <p style={{ color: "#f85149", fontSize: 13 }}>⚠ {err}</p>}

      {/* ── Intake ── */}
      <section style={cardBox}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Cole a tarefa ou prompt cru…"
          rows={5}
          style={ta}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={doTriage} disabled={busyT || !input.trim()} style={btn(false)}>
            {busyT ? "Triando…" : "✦ Triar"}
          </button>

          <div style={{ display: "flex", gap: 4 }}>
            {MODES.map((m) => (
              <button
                key={m.mode}
                onClick={() => setMode(m.mode)}
                title={m.hint}
                style={seg(mode === m.mode)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <button onClick={doEnhance} disabled={busyE || !input.trim()} style={btn(true)}>
            {busyE ? "Refinando…" : "Refinar"}
          </button>
        </div>

        {triage && (
          <div style={triageBox}>
            <span style={badge("#1f6feb")}>refino: {REFINO_LABEL[triage.refino]}</span>
            <span style={badge(FORCA_COLOR[triage.forca])}>força: {FORCA_LABEL[triage.forca]}</span>
            <span style={{ fontSize: 12.5, color: theme.textMuted, flex: 1, minWidth: 200 }}>{triage.rationale}</span>
          </div>
        )}
      </section>

      {/* ── Result ── */}
      {result && (
        <section style={{ ...cardBox, marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: theme.textFaint }}>
              refinado · {result.mode} · {result.model}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => navigator.clipboard?.writeText(result.enhanced)} style={btn(false)}>Copiar</button>
              <button onClick={() => setSaving((v) => !v)} style={btn(true)}>Salvar no banco</button>
            </div>
          </div>
          <pre style={pre}>{result.enhanced}</pre>
          {result.rationale && (
            <p style={{ margin: "10px 0 0", fontSize: 12.5, color: theme.textMuted }}>
              <strong style={{ color: theme.text }}>O que melhorou:</strong> {result.rationale}
            </p>
          )}
          {saving && (
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título" style={inp(220)} />
              <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, separadas, por, vírgula" style={inp(260)} />
              <button onClick={doSave} style={btn(true)}>Salvar</button>
            </div>
          )}
        </section>
      )}

      {/* ── Bank ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "26px 0 12px" }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Banco de prompts</h2>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            refreshBank(e.target.value).catch((er) => setErr(String(er)));
          }}
          placeholder="Buscar…"
          style={inp(220)}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {bank.length === 0 && <p style={{ color: theme.textFaint, fontSize: 13 }}>Nenhum prompt no banco.</p>}
        {bank.map((p) => (
          <section key={p.id} style={cardBox}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 600 }}>{p.title}</div>
                {p.tags.length > 0 && (
                  <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                    {p.tags.map((t) => (
                      <span key={t} style={tag}>{t}</span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button onClick={() => navigator.clipboard?.writeText(p.body)} style={btn(false)}>Copiar</button>
                <button onClick={() => doDelete(p.id)} style={btnDanger}>Excluir</button>
              </div>
            </div>
            <pre style={{ ...pre, marginTop: 10, maxHeight: 140, overflow: "auto" }}>{p.body}</pre>
          </section>
        ))}
      </div>
    </div>
  );
}

const cardBox: React.CSSProperties = { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, padding: 16 };
const triageBox: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap", paddingTop: 12, borderTop: `1px solid ${theme.border}` };
const ta: React.CSSProperties = { width: "100%", boxSizing: "border-box", background: theme.inset, border: `1px solid ${theme.border2}`, borderRadius: 8, padding: "10px 12px", color: theme.text, fontSize: 13.5, fontFamily: "ui-sans-serif, system-ui", resize: "vertical", lineHeight: 1.5 };
const pre: React.CSSProperties = { margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12.5, lineHeight: 1.55, color: theme.text, background: theme.inset, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 12, fontFamily: "ui-monospace, SFMono-Regular, monospace" };
const tag: React.CSSProperties = { fontSize: 11, color: theme.textMuted, background: theme.surface2, border: `1px solid ${theme.border2}`, borderRadius: 20, padding: "2px 9px" };

function badge(color: string): React.CSSProperties {
  return { fontSize: 12, fontWeight: 600, color: "#fff", background: color, borderRadius: 6, padding: "3px 9px" };
}
function inp(w: number): React.CSSProperties {
  return { flex: `0 1 ${w}px`, minWidth: 120, background: theme.surface, border: `1px solid ${theme.border2}`, borderRadius: 8, padding: "8px 11px", color: theme.text, fontSize: 13 };
}
function btn(primary: boolean): React.CSSProperties {
  return { background: primary ? theme.accent : theme.surface3, border: `1px solid ${theme.border2}`, color: primary ? "#fff" : theme.textMuted, borderRadius: 8, padding: "8px 13px", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" };
}
const btnDanger: React.CSSProperties = { background: theme.surface3, border: "1px solid #3a2530", color: "#f85149", borderRadius: 8, padding: "8px 13px", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" };
function seg(active: boolean): React.CSSProperties {
  return { background: active ? theme.surface3 : "transparent", border: `1px solid ${active ? theme.border2 : theme.border}`, color: active ? theme.text : theme.textMuted, borderRadius: 7, padding: "8px 12px", fontSize: 12.5, cursor: "pointer" };
}
