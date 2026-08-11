"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Columns3, Eye, LayoutGrid, MessageSquare, X } from "lucide-react";
import { useCockpit, type StageMode } from "../lib/cockpit-context";
import { useProject } from "../lib/project-context";
import { brokk } from "../lib/api";
import Fleet from "./Fleet";
import Chat from "./Chat";

const Board = dynamic(() => import("./Board"), { ssr: false });

const MODES: { id: StageMode; label: string; icon: typeof LayoutGrid }[] = [
  { id: "house", label: "House", icon: LayoutGrid },
  { id: "preview", label: "Preview", icon: Eye },
  { id: "forge", label: "Forge", icon: Columns3 },
];

function StageToolbar() {
  const { stageMode, setStageMode, chatOpen, setChatOpen, closeChat } = useCockpit();
  const { currentId, projects } = useProject();
  const current = projects.find((p) => p.id === currentId);

  return (
    <div className="cockpit-stage-bar" role="toolbar" aria-label="Modo do palco">
      <div className="cockpit-stage-modes">
        {MODES.map((m) => {
          const Icon = m.icon;
          const on = stageMode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              className={`cockpit-mode${on ? " is-on" : ""}`}
              aria-pressed={on}
              onClick={() => setStageMode(m.id)}
            >
              <Icon size={14} strokeWidth={1.75} aria-hidden />
              <span>{m.label}</span>
            </button>
          );
        })}
      </div>
      <div className="cockpit-stage-actions">
        {current ? (
          <span className="cockpit-stage-project" title={current.name}>
            {current.name}
          </span>
        ) : null}
        <button
          type="button"
          className={`cockpit-mode${chatOpen ? " is-on" : ""}`}
          aria-pressed={chatOpen}
          title={chatOpen ? "Fechar chat" : "Abrir chat"}
          onClick={() => (chatOpen ? closeChat() : setChatOpen(true))}
        >
          <MessageSquare size={14} strokeWidth={1.75} aria-hidden />
          <span>Chat</span>
        </button>
      </div>
    </div>
  );
}

function PreviewStage() {
  const { currentId, projects } = useProject();
  const project = projects.find((p) => p.id === currentId);
  const [sub, setSub] = useState<string | null>(null);

  useEffect(() => {
    if (!currentId) {
      setSub(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const ps = await brokk.listPreviews(currentId);
        const live = ps.find((x) => x.status === "live");
        if (alive) setSub(live?.subdomain ?? null);
      } catch {
        if (alive) setSub(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [currentId]);

  if (!project) {
    return (
      <div className="cockpit-empty">Selecione um projeto na House para ver o preview.</div>
    );
  }
  if (!sub) {
    return (
      <div className="cockpit-empty">
        Sem preview ao vivo para <strong>{project.name}</strong>. Abra o Preview pelo card
        ou espere o status live.
      </div>
    );
  }
  return (
    <div className="cockpit-preview-frame">
      <iframe
        title={`Preview ${project.name}`}
        src={`/preview-gate/${encodeURIComponent(sub)}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </div>
  );
}

function ForgeStage() {
  const { currentId, projects } = useProject();
  const project = projects.find((p) => p.id === currentId);
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
  const { chatOpen, closeChat, stageMode } = useCockpit();

  return (
    <div className={`cockpit${chatOpen ? " is-chat" : ""}`}>
      {chatOpen ? (
        <aside className="cockpit-chat" aria-label="Chat">
          <div className="cockpit-chat-head">
            <span>Chat</span>
            <button
              type="button"
              className="cockpit-chat-close"
              onClick={closeChat}
              aria-label="Fechar chat"
            >
              <X size={16} />
            </button>
          </div>
          <div className="cockpit-chat-body">
            <Chat mode="rail" />
          </div>
        </aside>
      ) : null}
      <section className="cockpit-stage" aria-label="Palco">
        <StageToolbar />
        <div className="cockpit-stage-body">
          {stageMode === "house" ? <Fleet compact={chatOpen} /> : null}
          {stageMode === "preview" ? <PreviewStage /> : null}
          {stageMode === "forge" ? <ForgeStage /> : null}
        </div>
      </section>
    </div>
  );
}

/** House cockpit — Chat rail + adaptive stage (House | Preview | Forge).
 *  Provider lives in the app layout so Topbar shares the same state. */
export default function Cockpit() {
  return <CockpitInner />;
}
