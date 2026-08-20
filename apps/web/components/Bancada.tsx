"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Bancada } from "@brokk/sdk";

interface AgentMessage {
  id: number;
  role: "user" | "agent";
  content: string;
}

interface Props {
  projectId: string;
  /** `rail` mostra só a conversa com o agente (a coluna lateral do cockpit);
   *  `full` mostra conversa + preview lado a lado. */
  variant?: "full" | "rail";
}

const LABEL: Record<string, string> = {
  provisioning: "subindo…",
  ready: "pronta",
  failed: "falhou",
  stopped: "parada",
  deleting: "removendo…",
};

/**
 * A bancada — o ambiente quente do projeto (ADR 0100).
 *
 * Duas metades na mesma tela: à esquerda a conversa com o agente que trabalha
 * DENTRO da bancada, à direita o que ele está construindo, ao vivo. O Brokk
 * proxia o agente (a face dele nunca é exposta ao navegador); o preview é
 * servido pelo Coder por caminho e entra por iframe.
 *
 * A tela só faz `POST /bancadas` quando alguém pede — abrir uma bancada é
 * ligar uma máquina, não um efeito colateral de navegar.
 */
export default function BancadaPanel({ projectId, variant = "full" }: Props) {
  const [bancada, setBancada] = useState<Bancada | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [agentStatus, setAgentStatus] = useState<string>("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  // Existing bancada, if any — a list read, so opening the screen never boots a
  // machine on its own.
  useEffect(() => {
    let alive = true;
    void fetch(`/api/bancadas?projectId=${projectId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Bancada[]) => {
        if (alive) setBancada(rows.find((b) => b.lane === "dev") ?? rows[0] ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId]);

  // While a bancada is not `ready`, GET /bancadas/:id is what reconciles it —
  // the endpoint re-reads Coder. Polling stops as soon as it settles.
  useEffect(() => {
    if (!bancada?.id) return;
    if (bancada.status !== "provisioning") return;
    const t = setInterval(() => {
      void fetch(`/api/bancadas/${bancada.id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: Bancada | null) => b && setBancada(b))
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [bancada?.id, bancada?.status]);

  // The agent's conversation, read through Brokk.
  useEffect(() => {
    if (!bancada?.id || bancada.status !== "ready") return;
    let alive = true;
    const pull = () =>
      fetch(`/api/bancadas/${bancada.id}/agent`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { status: string; messages: AgentMessage[] } | null) => {
          if (!alive || !d) return;
          setMessages(d.messages ?? []);
          setAgentStatus(d.status);
        })
        .catch(() => {});
    void pull();
    const t = setInterval(pull, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [bancada?.id, bancada?.status]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const act = useCallback(
    async (path: string, init: RequestInit) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(path, init);
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          setError((body as { error?: string })?.error ?? `falhou (${res.status})`);
          return null;
        }
        return body;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const open = (restart = false) =>
    act("/api/bancadas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, restart }),
    }).then((b) => b && setBancada(b as Bancada));

  const stop = () =>
    bancada &&
    act(`/api/bancadas/${bancada.id}/stop`, { method: "POST" }).then(
      (b) => b && setBancada(b as Bancada),
    );

  const send = async () => {
    const content = draft.trim();
    if (!content || !bancada) return;
    setDraft("");
    // Optimistic: the agent's own transcript is the truth, but a turn can take
    // seconds to appear there and a message that vanishes reads as a bug.
    setMessages((m) => [...m, { id: Date.now(), role: "user", content }]);
    await act(`/api/bancadas/${bancada.id}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  };

  const status = bancada?.status ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 12 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong>Bancada</strong>
        {status && (
          <span className={status === "ready" ? "forge-chip is-accent" : "forge-chip is-ember"}>
            {LABEL[status] ?? status}
          </span>
        )}
        {agentStatus === "running" && <span className="forge-chip is-ember">agente trabalhando</span>}
        <span style={{ flex: 1 }} />
        {(!bancada || status === "stopped" || status === "failed") && (
          <button className="forge-btn" disabled={busy} onClick={() => void open()}>
            {status === "stopped" ? "Religar" : "Abrir bancada"}
          </button>
        )}
        {status === "ready" && (
          <>
            <button className="forge-btn" disabled={busy} onClick={() => void open(true)}>
              Recriar
            </button>
            <button className="forge-btn" disabled={busy} onClick={() => void stop()}>
              Parar
            </button>
          </>
        )}
      </header>

      {(error || bancada?.detail) && (
        <p style={{ color: "var(--err)", margin: 0, fontSize: 13 }}>{error ?? bancada?.detail}</p>
      )}

      {!bancada && !busy && (
        <p style={{ opacity: 0.7, fontSize: 13, margin: 0 }}>
          Nenhuma bancada aberta. Abrir uma liga uma máquina com o checkout, o dev server, o
          agente e o navegador — e ela é descartável: apagar e recriar reconstrói tudo do git.
        </p>
      )}

      {bancada && (
        <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
          <section
            style={{
              flex: variant === "rail" ? 1 : "0 0 38%",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              border: "1px solid var(--line)",
              borderRadius: 8,
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: 12, minHeight: 0 }}>
              {messages.length === 0 && (
                <p style={{ opacity: 0.6, fontSize: 13 }}>
                  O agente está dentro da bancada. Peça uma mudança e olhe o preview ao lado.
                </p>
              )}
              {messages.map((m) => (
                <div key={m.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>
                    {m.role === "user" ? "você" : "agente"}
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontSize: 13,
                      fontFamily: "inherit",
                    }}
                  >
                    {m.content}
                  </pre>
                </div>
              ))}
              <div ref={bottom} />
            </div>
            <div style={{ display: "flex", gap: 6, padding: 8, borderTop: "1px solid var(--line)" }}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={status === "ready" ? "o que fazer aqui…" : "bancada não está pronta"}
                disabled={status !== "ready" || busy}
                style={{ flex: 1 }}
              />
              <button
                className="forge-btn"
                disabled={status !== "ready" || busy || !draft.trim()}
                onClick={() => void send()}
              >
                Enviar
              </button>
            </div>
          </section>

          {variant === "full" && (
          <section
            style={{
              flex: 1,
              minHeight: 0,
              border: "1px solid var(--line)",
              borderRadius: 8,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderBottom: "1px solid var(--line)",
                fontSize: 12,
              }}
            >
              <span style={{ opacity: 0.7 }}>{bancada.branch}</span>
              <span style={{ flex: 1 }} />
              {bancada.previewUrl && (
                <a href={bancada.previewUrl} target="_blank" rel="noreferrer">
                  abrir em nova aba ↗
                </a>
              )}
            </div>
            {bancada.previewUrl && status === "ready" ? (
              <iframe
                src={bancada.previewUrl}
                title="preview"
                style={{ flex: 1, border: 0, background: "#fff" }}
              />
            ) : (
              <p style={{ padding: 12, opacity: 0.7, fontSize: 13 }}>
                {status === "provisioning"
                  ? "Subindo a bancada — ela só se declara pronta quando o dev server responde."
                  : "Sem preview no ar."}
              </p>
            )}
          </section>
          )}
        </div>
      )}
    </div>
  );
}
