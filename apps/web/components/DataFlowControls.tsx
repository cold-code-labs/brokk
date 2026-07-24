"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Radar, Target } from "lucide-react";
import { ComposerMenu } from "./ComposerMenu";
import { dataFlow, type DataFlowCatalog, type DataFlowRoom } from "../lib/chat";

type Props = {
  projectId: string | null | undefined;
  disabled?: boolean;
  onRun: (opts: { mode: "full" | "targeted" | "discover"; rooms: DataFlowRoom[]; catalog: DataFlowCatalog | null }) => void;
};

/** Cockpit: Discover data-flow · Full audit · Targeted (espelho QaControls). */
export function DataFlowControls({ projectId, disabled, onRun }: Props) {
  const [catalog, setCatalog] = useState<DataFlowCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetActive, setTargetActive] = useState(0);
  const targetRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = await dataFlow.get(projectId);
      setCatalog(r.catalog);
    } catch {
      /* ignore */
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rooms = catalog?.rooms ?? [];
  const ready = rooms.length > 0;

  const targetItems = useMemo(
    () =>
      rooms.map((r) => ({
        id: r.id,
        label: r.entity || r.id,
        hint: `${r.kind} · ${r.route}`,
        tag: r.priority || "p?",
      })),
    [rooms],
  );

  async function discover() {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const r = await dataFlow.discover(projectId);
      setCatalog(r.catalog);
    } catch {
      /* fallback: agent-side discover via prompt */
      onRun({ mode: "discover", rooms: [], catalog: null });
    } finally {
      setBusy(false);
    }
  }

  function runFull() {
    if (!catalog) return;
    onRun({ mode: "full", rooms, catalog });
  }

  function runTargeted(id: string) {
    const hit = rooms.find((r) => r.id === id);
    if (!hit || !catalog) return;
    setTargetOpen(false);
    onRun({ mode: "targeted", rooms: [hit], catalog });
  }

  return (
    <div className="sindri-qa-controls" data-testid="sindri-data-flow-controls">
      {ready ? (
        <span className="sindri-qa-count" title={catalog?.summary ?? undefined}>
          {rooms.length} rooms
        </span>
      ) : null}
      <button
        type="button"
        className={`sindri-chip sindri-qa-btn${busy ? " is-busy" : ""}`}
        title="Descobrir catálogo user-data-flow + audit estático"
        aria-label="Data-flow Discovery"
        data-testid="sindri-df-discover"
        disabled={disabled || busy || !projectId}
        onClick={() => void discover()}
      >
        <Radar size={13} />
        <span className="sindri-chip-label">{busy ? "Flow…" : "Flow"}</span>
      </button>
      <button
        type="button"
        className="sindri-chip sindri-qa-btn"
        title={ready ? `Full data-flow audit · ${rooms.length} salas` : "Rode Flow (Discover) antes"}
        aria-label="Full data-flow"
        data-testid="sindri-df-full"
        disabled={disabled || !ready}
        onClick={runFull}
      >
        <GitBranch size={13} />
        <span className="sindri-chip-label">Full flow</span>
      </button>
      <div className={`sindri-chip-wrap${targetOpen ? " is-open" : ""}`}>
        <button
          ref={targetRef}
          type="button"
          className="sindri-chip sindri-qa-btn"
          title={ready ? "Targeted data-flow — uma sala" : "Rode Flow antes"}
          aria-label="Targeted data-flow"
          aria-haspopup="listbox"
          aria-expanded={targetOpen}
          data-testid="sindri-df-targeted"
          disabled={disabled || !ready}
          onClick={() => {
            if (!ready) return;
            setTargetActive(0);
            setTargetOpen((o) => !o);
          }}
        >
          <Target size={13} />
          <span className="sindri-chip-label">Target flow</span>
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
          emptyHint="Nenhuma sala — rode Flow"
        />
      </div>
    </div>
  );
}

export function buildDataFlowRunPrompt(opts: {
  mode: "full" | "targeted" | "discover";
  rooms: DataFlowRoom[];
  catalog: DataFlowCatalog | null;
}): string {
  if (opts.mode === "discover") {
    return `/user-data-flow discover — call invoke_skill → data-flow-discover (refresh catalog + static audit). Summarize pass/fail/deferred. Do not edit product code.`;
  }
  const catalog = {
    version: opts.catalog?.version ?? 1,
    fingerprint: opts.catalog?.fingerprint,
    summary: opts.catalog?.summary,
    rooms: opts.rooms,
  };
  const head =
    opts.mode === "full"
      ? "Execute Full user-data-flow Audit against the catalog (p0 first, static + live if preview). Pin /user-data-flow."
      : `Execute Targeted user-data-flow Audit for room(s): ${opts.rooms.map((r) => r.id).join(", ")}. Pin /user-data-flow.`;
  return `/user-data-flow ${head}\n\nWhen done call invoke_skill → submit_data_flow_report with results[] and summary.\n\n\`\`\`json\n${JSON.stringify(catalog, null, 2)}\n\`\`\``;
}
