"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical, Radar, Target } from "lucide-react";
import { ComposerMenu } from "./ComposerMenu";
import { useToast } from "./Toaster";
import { qa, type QaCatalog, type QaRun, type QaScenario } from "../lib/chat";

type Props = {
  projectId: string | null | undefined;
  disabled?: boolean;
  engine: string;
  onRun: (opts: {
    mode: "full" | "targeted";
    scenarios: QaScenario[];
    stale: boolean;
    summary: string | null;
    /** Set when the cockpit already created a `running` row; Chat may create one. */
    runId?: string;
  }) => void;
};

/** Cockpit controls: Discover scenarios · Full QA · Targeted QA (+ stale badge). */
export function QaControls({ projectId, disabled, engine, onRun }: Props) {
  const toast = useToast();
  const [catalog, setCatalog] = useState<QaCatalog | null>(null);
  const [running, setRunning] = useState(false);
  const [stale, setStale] = useState(false);
  const [lastRun, setLastRun] = useState<QaRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetActive, setTargetActive] = useState(0);
  const targetRef = useRef<HTMLButtonElement>(null);
  const watchedRunId = useRef<string | null>(null);
  const toastedRunId = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = await qa.get(projectId);
      setCatalog(r.catalog);
      setRunning(r.running || r.catalog?.status === "pending");
      setStale(Boolean(r.stale));
      setLastRun(r.lastRun);
      if (r.lastRun?.status === "running") {
        watchedRunId.current = r.lastRun.id;
      } else if (
        r.lastRun &&
        r.lastRun.status === "ready" &&
        watchedRunId.current === r.lastRun.id &&
        toastedRunId.current !== r.lastRun.id
      ) {
        toastedRunId.current = r.lastRun.id;
        watchedRunId.current = null;
        toast("Report salvo — abra a página de QA", { tone: "ok" });
      }
    } catch {
      /* ignore */
    }
  }, [projectId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll catalog + lastRun while Discovery or Execution may be in flight.
  useEffect(() => {
    if (!projectId) return;
    const i = setInterval(() => void load(), 5000);
    return () => clearInterval(i);
  }, [projectId, load]);

  const scenarios = catalog?.status === "ready" ? catalog.scenarios : [];
  const ready = catalog?.status === "ready" && scenarios.length > 0;
  // OpenCode Auto is the only Chat mode; Playwright MCP rides the same session.
  const cliOk = engine === "opencode" || engine === "cursor-cli" || engine === "claude-cli";
  const qaHref = projectId ? `/projects/${projectId}/qa` : null;
  const execRunning = lastRun?.status === "running";
  const progressFromSummary =
    execRunning && lastRun.summary?.startsWith("In progress")
      ? lastRun.summary.replace(/^In progress ·\s*/i, "")
      : null;
  const progressLabel = execRunning
    ? progressFromSummary
      ? `${lastRun.mode === "full" ? "Full" : "Targeted"} · ${progressFromSummary}`
      : `${lastRun.mode === "full" ? "Full QA" : "Targeted"} running · ${lastRun.scenarioIds.length || "?"} scen`
    : null;

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

  async function startAndRun(mode: "full" | "targeted", picked: QaScenario[]) {
    if (!projectId || !ready) return;
    onRun({
      mode,
      scenarios: picked,
      stale,
      summary: catalog?.summary ?? null,
    });
  }

  function runFull() {
    void startAndRun("full", scenarios);
  }

  function runTargeted(id: string) {
    const hit = scenarios.find((s) => s.id === id);
    if (!hit) return;
    setTargetOpen(false);
    void startAndRun("targeted", [hit]);
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
      ? "Full QA precisa do motor Cursor CLI (ou Claude CLI) com Playwright MCP"
      : stale
        ? "Catálogo defasado — Full QA pode falhar em fluxos novos; prefira Discovery"
        : `Full QA · ${scenarios.length} cenários`;

  return (
    <div className="sindri-qa-controls" data-testid="sindri-qa-controls">
      {progressLabel && qaHref ? (
        <Link href={qaHref} className="sindri-qa-live" title="Abrir página de QA do projeto">
          {progressLabel}
        </Link>
      ) : null}
      {stale && ready ? (
        <span className="sindri-qa-stale" title="Fingerprint de rotas/features/e2e mudou desde o Discovery">
          stale
        </span>
      ) : null}
      {ready && qaHref ? (
        <Link
          href={qaHref}
          className="sindri-qa-count"
          title={catalog?.summary ?? "Abrir catálogo de QA"}
        >
          {scenarios.length} scen
        </Link>
      ) : ready ? (
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
        disabled={disabled || !ready || !cliOk || execRunning}
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
                ? "Targeted QA precisa do motor Cursor CLI (ou Claude CLI)"
                : "Targeted QA — escolher um cenário"
          }
          aria-label="Targeted QA"
          aria-haspopup="listbox"
          aria-expanded={targetOpen}
          data-testid="sindri-qa-targeted"
          disabled={disabled || !ready || !cliOk || execRunning}
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
  runId: string;
}): string {
  const catalog = {
    version: 1,
    runId: opts.runId,
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
  const persistNote = `\n\nrunId=${opts.runId}. Between scenarios call invoke_skill → qa-progress {index,total,id,runId}. When done call invoke_skill → submit_qa_report with the same runId, results[], and summary. Watch the live Chromium via Preview → Assistir o agente. Prefer engine cursor-cli (CURSOR_API_KEY).`;
  return `/full-qa ${head}${staleNote}${persistNote}\n\n\`\`\`json\n${JSON.stringify(catalog, null, 2)}\n\`\`\``;
}
