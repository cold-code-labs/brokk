"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Columns3, Eye, LayoutGrid, X } from "lucide-react";
import { useCockpit, type StageMode } from "../lib/cockpit-context";
import { prettyProjectName } from "../lib/house";
import { useProject } from "../lib/project-context";
import { brokk } from "../lib/api";
import Fleet from "./Fleet";
import BancadaPanel from "./Bancada";

const Board = dynamic(() => import("./Board"), { ssr: false });

const MODES: { id: StageMode; label: string }[] = [
  { id: "house", label: "House" },
  { id: "preview", label: "Preview" },
  { id: "forge", label: "Forge" },
];

function StageToolbar() {
  const { stageMode, setStageMode, hasPicked } = useCockpit();
  const { currentId, projects } = useProject();
  const current = hasPicked ? projects.find((p) => p.id === currentId) : null;

  return (
    <div className="cockpit-stage-bar" role="toolbar" aria-label="Instrumentos do palco">
      <div className="cockpit-stage-modes" role="tablist">
        {MODES.map((m) => {
          const on = stageMode === m.id;
          const locked = m.id !== "house" && !current;
          return (
            <button
              key={m.id}
              type="button"
              role="tab"
              className={`cockpit-mode${on ? " is-on" : ""}`}
              aria-selected={on}
              disabled={locked}
              title={locked ? "Selecione um projeto" : m.label}
              onClick={() => setStageMode(m.id)}
            >
              {m.id === "house" ? <LayoutGrid size={13} strokeWidth={1.75} aria-hidden /> : null}
              {m.id === "preview" ? <Eye size={13} strokeWidth={1.75} aria-hidden /> : null}
              {m.id === "forge" ? <Columns3 size={13} strokeWidth={1.75} aria-hidden /> : null}
              <span>{m.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PreviewStage() {
  const { currentId, projects } = useProject();
  const { hasPicked } = useCockpit();
  const project = hasPicked ? projects.find((p) => p.id === currentId) : null;
  const [sub, setSub] = useState<string | null>(null);

  useEffect(() => {
    if (!project) {
      setSub(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/bancadas?projectId=${project.id}`);
        const rows: { status: string; previewUrl: string | null }[] = res.ok ? await res.json() : [];
        const ready = rows.find((b) => b.status === "ready" && b.previewUrl);
        if (alive) setSub(ready?.previewUrl ?? null);
      } catch {
        if (alive) setSub(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [project]);

  if (!project) {
    return (
      <div className="cockpit-empty">Selecione um projeto na House para ver o preview.</div>
    );
  }
  if (!sub) {
    return (
      <div className="cockpit-empty">
        Sem bancada no ar para <strong>{prettyProjectName(project.name)}</strong>.
      </div>
    );
  }
  return (
    <div className="cockpit-preview-frame">
      <iframe
        title={`Preview ${project.name}`}
        src={sub}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </div>
  );
}

function ForgeStage() {
  const { currentId, projects } = useProject();
  const { hasPicked } = useCockpit();
  const project = hasPicked ? projects.find((p) => p.id === currentId) : null;
  if (!project || !currentId) {
    return (
      <div className="cockpit-empty">Selecione um projeto na House para abrir o Forge.</div>
    );
  }
  return (
    <div className="cockpit-forge">
      <Board projectId={currentId} />
    </div>
  );
}

function CockpitInner() {
  const { chatOpen, closeChat, stageMode, hasPicked } = useCockpit();
  const { currentId, projects } = useProject();
  const current = hasPicked ? projects.find((p) => p.id === currentId) : null;
  const showChat = chatOpen && Boolean(current);

  return (
    <div className={`cockpit${showChat ? " is-chat" : ""}`}>
      {showChat && current ? (
        <aside className="cockpit-chat" aria-label="Bancada">
          <div className="cockpit-chat-head">
            <div className="cockpit-chat-who">
              <span className="cockpit-chat-kicker">Bancada</span>
              <strong>{prettyProjectName(current.name)}</strong>
            </div>
            <button
              type="button"
              className="cockpit-chat-close"
              onClick={closeChat}
              aria-label="Fechar bancada"
            >
              <X size={16} />
            </button>
          </div>
          <div className="cockpit-chat-body">
            <BancadaPanel projectId={current.id} variant="rail" />
          </div>
        </aside>
      ) : null}
      <section className="cockpit-stage" aria-label="Palco">
        <StageToolbar />
        <div className="cockpit-stage-body">
          {stageMode === "house" ? <Fleet compact={showChat} /> : null}
          {stageMode === "preview" ? <PreviewStage /> : null}
          {stageMode === "forge" ? <ForgeStage /> : null}
        </div>
      </section>
    </div>
  );
}

/** House cockpit — trilho da bancada + palco adaptativo (House | Preview | Forge). */
export default function Cockpit() {
  return <CockpitInner />;
}
