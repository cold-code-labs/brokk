"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical, Radar, Target } from "lucide-react";
import { ComposerMenu } from "./ComposerMenu";
import { qa, type QaCatalog, type QaScenario } from "../lib/chat";

type Props = {
  projectId: string | null | undefined;
  disabled?: boolean;
  engine: string;
  onRun: (opts: {
    mode: "full" | "targeted";
    scenarios: QaScenario[];
    stale: boolean;
    summary: string | null;
  }) => void;
};

/** Cockpit controls: Discover scenarios · Full QA · Targeted QA (+ stale badge). */
export function QaControls({ projectId, disabled, engine, onRun }: Props) {
  const [catalog, setCatalog] = useState<QaCatalog | null>(null);
  const [running, setRunning] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetActive, setTargetActive] = useState(0);
  const targetRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = await qa.get(projectId);
      setCatalog(r.catalog);
      setRunning(r.running || r.catalog?.status === "pending");
      setStale(Boolean(r.stale));
    } catch {
      /* ignore */
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!running) return;
    const i = setInterval(() => void load(), 4000);
    return () => clearInterval(i);
  }, [running, load]);

  const scenarios = catalog?.status === "ready" ? catalog.scenarios : [];
  const ready = catalog?.status === "ready" && scenarios.length > 0;
  const cliOk = engine === "claude-cli";

  const targetItems = useMemo(
    () =>
      scenarios.map((s) => ({
        id: s.id,
        label: s.title,
        hint: `${s.module} · ${s.priority}`,
        tag: s.tags.includes("global") ? "global" : s.module,
      })),
    [scenarios],
  );

  async function discover() {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      await qa.discover(projectId);
      setRunning(true);
      setCatalog((c) => (c ? { ...c, status: "pending" } : c));
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  function runFull() {
    if (!ready) return;
    onRun({
      mode: "full",
      scenarios,
      stale,
      summary: catalog?.summary ?? null,
    });
  }

  function runTargeted(id: string) {
    const hit = scenarios.find((s) => s.id === id);
    if (!hit) return;
    setTargetOpen(false);
    onRun({
      mode: "targeted",
      scenarios: [hit],
      stale,
      summary: catalog?.summary ?? null,
    });
  }

  const discoverTitle = running
    ? "QA Discovery em andamento…"
    : stale
      ? "Catálogo defasado — redescobrir cenários (rotas/features mudaram)"
      : ready
        ? "Redescobrir cenários de QA"
        : "Descobrir cenários de QA (Discovery)";

  const fullTitle = !ready
    ? "Rode Discovery antes do Full QA"
    : !cliOk
      ? "Full QA precisa do motor Claude CLI (Playwright MCP)"
      : stale
        ? "Catálogo defasado — Full QA pode falhar em fluxos novos; prefira Discovery"
        : `Full QA · ${scenarios.length} cenários`;

  return (
    <div className="sindri-qa-controls" data-testid="sindri-qa-controls">
      {stale && ready ? (
        <span className="sindri-qa-stale" title="Fingerprint de rotas/features/e2e mudou desde o Discovery">
          stale
        </span>
      ) : null}
      {ready ? (
        <span className="sindri-qa-count" title={catalog?.summary ?? undefined}>
          {scenarios.length} scen
        </span>
      ) : null}
      <button
        type="button"
        className={`sindri-chip sindri-qa-btn${stale ? " is-stale" : ""}${running ? " is-busy" : ""}`}
        title={discoverTitle}
        aria-label="QA Discovery"
        data-testid="sindri-qa-discover"
        disabled={disabled || busy || running || !projectId}
        onClick={() => void discover()}
      >
        <Radar size={13} />
        <span className="sindri-chip-label">{running ? "Discover…" : "Discover"}</span>
      </button>
      <button
        type="button"
        className="sindri-chip sindri-qa-btn"
        title={fullTitle}
        aria-label="Full QA"
        data-testid="sindri-qa-full"
        disabled={disabled || !ready || !cliOk}
        onClick={runFull}
      >
        <FlaskConical size={13} />
        <span className="sindri-chip-label">Full QA</span>
      </button>
      <div className={`sindri-chip-wrap${targetOpen ? " is-open" : ""}`}>
        <button
          ref={targetRef}
          type="button"
          className="sindri-chip sindri-qa-btn"
          title={
            !ready
              ? "Rode Discovery antes do Targeted QA"
              : !cliOk
                ? "Targeted QA precisa do motor Claude CLI"
                : "Targeted QA — escolher um cenário"
          }
          aria-label="Targeted QA"
          aria-haspopup="listbox"
          aria-expanded={targetOpen}
          data-testid="sindri-qa-targeted"
          disabled={disabled || !ready || !cliOk}
          onClick={() => {
            if (!ready || !cliOk) return;
            setTargetActive(0);
            setTargetOpen((o) => !o);
          }}
        >
          <Target size={13} />
          <span className="sindri-chip-label">Targeted</span>
        </button>
        <ComposerMenu
          open={targetOpen}
          portal
          anchorRef={targetRef}
          align="end"
          placement="above"
          items={targetItems}
          activeIndex={targetActive}
          onActiveIndex={setTargetActive}
          onPick={runTargeted}
          onClose={() => setTargetOpen(false)}
          emptyHint="Nenhum cenário — rode Discover"
        />
      </div>
    </div>
  );
}

/** Build the user prompt that pins /full-qa and feeds the catalog to Sindri. */
export function buildQaRunPrompt(opts: {
  mode: "full" | "targeted";
  scenarios: QaScenario[];
  stale: boolean;
  summary: string | null;
}): string {
  const catalog = {
    version: 1,
    summary: opts.summary,
    stale: opts.stale,
    scenarios: opts.scenarios,
  };
  const head =
    opts.mode === "full"
      ? "Execute Full QA against the catalog below (all scenarios, p0 first). Pin /full-qa."
      : `Execute Targeted QA for scenario(s): ${opts.scenarios.map((s) => s.id).join(", ")}. Pin /full-qa.`;
  const staleNote = opts.stale
    ? "\n\nWARNING: catalog is STALE (routes/features/e2e fingerprint drifted). Note gaps; prefer re-Discover after this run if failures look like missing surfaces."
    : "";
  return `/full-qa ${head}${staleNote}\n\n\`\`\`json\n${JSON.stringify(catalog, null, 2)}\n\`\`\``;
}
