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
import { Droplets } from "lucide-react";
import {
  Main,
  Banner,
  Button,
  Input,
  Textarea,
} from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";

const MODES: { mode: MimirMode; label: string; hint: string }[] = [
  { mode: "polish", label: "Light", hint: "Clarity and grammar only" },
  { mode: "structure", label: "Standard", hint: "Context → task → output" },
  { mode: "engineer", label: "Full", hint: "Full engineering archetype" },
];

const REFINO_LABEL: Record<RefinoLevel, string> = {
  none: "Already clear",
  polish: "Light",
  structure: "Standard",
  engineer: "Full archetype",
};

const FORCA_LABEL: Record<ForcaLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  extra: "Extra",
};

/** Escalating badge tone for the force estimate — tokens only, never ember
 *  (the ember is running work; a triage verdict is cold information). */
const FORCA_TONE: Record<ForcaLevel, "info" | "warn" | "err" | undefined> = {
  low: undefined,
  medium: "info",
  high: "warn",
  extra: "err",
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
      {/* ── masthead: the well ── */}
      <header className="forge-head">
        <div className="forge-head-top">
          <div>
            <span className="forge-eyebrow">Brokk · the well</span>
            <h1 className="forge-title">Mímir</h1>
            <p className="forge-sub">
              Refine a prompt, keep it, draw it again. Mímir counsels, Brokkr forges, Eitri reviews.
            </p>
          </div>
        </div>
        <div className="forge-head-rule" />
      </header>

      {err && <Banner tone="err">{err}</Banner>}

      {/* ── Intake — one seamless surface: bare textarea on the panel, actions as
          a flush footer. The whole panel lights on focus (forge-bar language). */}
      <div className="forge-panel mimir-intake">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste the raw prompt…"
          rows={5}
          style={{ resize: "vertical", border: 0, background: "transparent", boxShadow: "none", padding: "0.35rem 0.2rem", outline: "none" }}
        />
        <div className="mimir-intake-foot" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Button variant="outline" size="sm" onClick={doTriage} disabled={busyT || !input.trim()}>
            {busyT ? "Triaging…" : "Triage"}
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
            {busyE ? "Refining…" : "Refine"}
          </Button>
        </div>

        {triage && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap", paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <span className="ygg-badge" data-tone="info">refine · {REFINO_LABEL[triage.refino]}</span>
            <span className="ygg-badge" data-tone={FORCA_TONE[triage.forca]}>
              force · {FORCA_LABEL[triage.forca]}
            </span>
            <span className="ygg-muted" style={{ fontSize: 12.5, flex: 1, minWidth: 200 }}>{triage.rationale}</span>
          </div>
        )}
      </div>

      {/* ── Result — the artifact is the message ── */}
      {result && (
        <div className="forge-panel" style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="forge-row-mono">
              {result.mode} · {result.model}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(result.enhanced)}>Copy</Button>
              <Button size="sm" onClick={() => setSaving((v) => !v)}>Save prompt</Button>
            </div>
          </div>
          <pre style={pre}>{result.enhanced}</pre>
          {result.rationale && (
            <p className="ygg-muted" style={{ margin: "10px 0 0", fontSize: 12.5 }}>
              <strong style={{ color: "var(--fg)" }}>What changed:</strong> {result.rationale}
            </p>
          )}
          {saving && (
            <div className="forge-bar" style={{ marginTop: 12 }}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
                aria-label="Title"
              />
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="tags, comma-separated"
                aria-label="Tags"
                style={{ borderLeft: "1px solid var(--line)" }}
              />
              <button type="button" className="forge-bar-send" onClick={doSave}>
                Save
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── The well — prompts kept, ready to draw ── */}
      <section style={{ marginTop: "2rem" }}>
        <div className="forge-h">
          <span className="forge-h-title">The well</span>
          <span className="forge-h-meta">{bank.length}</span>
          <span className="forge-h-rule" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              refreshBank(e.target.value).catch((er) => setErr(String(er)));
            }}
            placeholder="Search…"
            aria-label="Search prompts"
            style={{ flex: "0 1 220px", minWidth: 120 }}
          />
        </div>

        {bank.length === 0 ? (
          <div className="forge-empty is-panel">
            <span className="forge-empty-mark"><Droplets /></span>
            <span className="forge-empty-title">The well is empty</span>
            <p className="forge-empty-sub">Prompts you save are kept here, ready to draw. Refine one above and save it.</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {bank.map((p) => (
              <div key={p.id} className="forge-panel">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 650, color: "var(--fg)" }}>{p.title}</div>
                    {(p.tags.length > 0 || p.refineCount > 0) && (
                      <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
                        {p.tags.map((tag) => (
                          <span key={tag} className="forge-chip">{tag}</span>
                        ))}
                        {p.refineCount > 0 && (
                          <span className="forge-row-meta">refined ×{p.refineCount}</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <Button variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(p.body)}>Copy</Button>
                    <Button variant="destructive" size="sm" onClick={() => doDelete(p.id)}>Delete</Button>
                  </div>
                </div>
                <pre style={{ ...pre, marginTop: 10, maxHeight: 140, overflow: "auto" }}>{p.body}</pre>
              </div>
            ))}
          </div>
        )}
      </section>
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
  borderRadius: "var(--radius-sm)",
  padding: 12,
  fontFamily: "var(--font-mono, monospace)",
};
