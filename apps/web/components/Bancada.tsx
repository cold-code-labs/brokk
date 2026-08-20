"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@cold-code-labs/yggdrasil-react";
import { parseAgentScreen, type Bloco } from "@brokk/coder/screen";
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
 * A conversa NÃO é markdown: a AgentAPI devolve o buffer do terminal do CLI
 * (67 colunas, padding, `●`, `⎿`, diffs com número de linha). `parseAgentScreen`
 * transforma isso em blocos tipados e aqui cada tipo ganha a sua forma — sem
 * isso o chat parecia um log de servidor colado numa página.
 */
export default function BancadaPanel({ projectId, variant = "full" }: Props) {
  const [bancada, setBancada] = useState<Bancada | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [agentStatus, setAgentStatus] = useState<string>("unknown");
  const [previewLink, setPreviewLink] = useState<string | null>(null);
  const [previewPronto, setPreviewPronto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Mensagem escrita antes de a bancada ficar pronta. Fica guardada e sai
   *  sozinha quando ela chega — travar a caixa fazia parecer que quebrou. */
  const [naFila, setNaFila] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const status = bancada?.status ?? null;
  const pronta = status === "ready";

  // Abrir esta tela É pedir a bancada. Quem chega aqui quer trabalhar; exigir um
  // clique a mais só adiciona um passo entre a pessoa e a máquina que ela já
  // pediu. Uma bancada parada é religada; uma que já está de pé é adotada.
  useEffect(() => {
    let alive = true;
    (async () => {
      const rows: Bancada[] = await fetch(`/api/bancadas?projectId=${projectId}`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []);
      const atual = rows.find((b) => b.lane === "dev") ?? rows[0] ?? null;
      if (!alive) return;
      setBancada(atual);
      if (!atual || atual.status === "stopped") {
        const nova = await fetch("/api/bancadas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (alive && nova) setBancada(nova as Bancada);
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!bancada?.id || bancada.status !== "provisioning") return;
    const t = setInterval(() => {
      void fetch(`/api/bancadas/${bancada.id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: Bancada | null) => b && setBancada(b))
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [bancada?.id, bancada?.status]);

  useEffect(() => {
    if (!bancada?.id || !pronta) {
      setPreviewLink(null);
      setPreviewPronto(false);
      return;
    }
    let alive = true;
    void fetch(`/api/bancadas/${bancada.id}/link`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { url?: string } | null) => {
        if (alive && d?.url) setPreviewLink(d.url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bancada?.id, pronta]);

  useEffect(() => {
    if (!bancada?.id || !pronta) return;
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
  }, [bancada?.id, pronta]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const act = useCallback(async (path: string, init: RequestInit) => {
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
  }, []);

  const enviar = useCallback(
    async (conteudo: string) => {
      if (!bancada) return;
      setMessages((m) => [...m, { id: Date.now(), role: "user", content: conteudo }]);
      await act(`/api/bancadas/${bancada.id}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: conteudo }),
      });
    },
    [act, bancada],
  );

  // A mensagem escrita durante o boot sai sozinha assim que a bancada abre.
  useEffect(() => {
    if (pronta && naFila) {
      const texto = naFila;
      setNaFila(null);
      void enviar(texto);
    }
  }, [pronta, naFila, enviar]);

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

  const submeter = () => {
    const conteudo = draft.trim();
    if (!conteudo) return;
    setDraft("");
    if (pronta) void enviar(conteudo);
    else setNaFila(conteudo);
  };

  return (
    <div className="bancada">
      <header className="bancada-head">
        <strong>Bancada</strong>
        {status && (
          <span className={`forge-chip${pronta ? " is-accent" : " is-ember"}`}>
            {LABEL[status] ?? status}
          </span>
        )}
        {agentStatus === "running" && (
          <span className="forge-chip is-ember">
            <span className="bancada-pulse" /> agente trabalhando
          </span>
        )}
        <span style={{ flex: 1 }} />
        {(!bancada || status === "stopped" || status === "failed") && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void open()}>
            {status === "stopped" ? "Religar" : "Abrir bancada"}
          </Button>
        )}
        {pronta && (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void open(true)}>
              Recriar
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void stop()}>
              Parar
            </Button>
          </>
        )}
      </header>

      {(error || bancada?.detail) && <p className="bancada-erro">{error ?? bancada?.detail}</p>}

      <div className={`bancada-corpo${variant === "rail" ? " is-rail" : ""}`}>
        <section className="bancada-conversa">
          <div className="bancada-fluxo">
            {!pronta && <Subindo status={status} naFila={naFila} />}
            {pronta && messages.length === 0 && (
              <p className="bancada-vazio">
                O agente está dentro da bancada, na mesma máquina onde o preview roda. Peça uma
                mudança e olhe ao lado.
              </p>
            )}
            {semDuplicata(messages).map((m) => (
              <Mensagem key={m.id} role={m.role} content={m.content} />
            ))}
            <div ref={bottom} />
          </div>
          <div className="bancada-composer">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submeter();
                }
              }}
              placeholder={pronta ? "o que fazer aqui…" : "pode escrever — vai assim que abrir"}
              aria-label="Mensagem para o agente"
            />
            <Button size="sm" disabled={busy || !draft.trim()} onClick={submeter}>
              Enviar
            </Button>
          </div>
        </section>

        {variant === "full" && (
          <section className="bancada-palco">
            <div className="bancada-palco-barra">
              <span className="ygg-dim">{bancada?.branch ?? ""}</span>
              <span style={{ flex: 1 }} />
              {previewLink && (
                <a href={previewLink} target="_blank" rel="noreferrer">
                  abrir em nova aba ↗
                </a>
              )}
            </div>
            <div className="bancada-palco-frame">
              {previewLink && pronta ? (
                <>
                  {!previewPronto && <Esqueleto />}
                  <iframe
                    src={previewLink}
                    title="preview"
                    className={`bancada-iframe${previewPronto ? " is-visivel" : ""}`}
                    onLoad={() => setPreviewPronto(true)}
                  />
                </>
              ) : (
                <Esqueleto legenda={pronta ? "Preparando o preview…" : "Subindo a bancada…"} />
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** Tira a bolha otimista cujo texto o terminal já devolveu como eco — senão o
 *  mesmo pedido aparece duas vezes assim que o agente responde. */
function semDuplicata(ms: AgentMessage[]): AgentMessage[] {
  const noTerminal = new Set(
    ms
      .filter((m) => m.role === "agent")
      .flatMap((m) =>
        parseAgentScreen(m.content)
          .filter((b) => b.tipo === "eco")
          .map((b) => b.linhas.join(" ").trim()),
      ),
  );
  return ms.filter((m) => !(m.role === "user" && noTerminal.has(m.content.trim())));
}

/** O que aparece enquanto a máquina liga. Antes era uma caixa de texto morta
 *  dizendo "bancada não está pronta" — que lê como erro, não como espera. */
function Subindo({ status, naFila }: { status: string | null; naFila: string | null }) {
  const falhou = status === "failed";
  return (
    <div className="bancada-subindo">
      {!falhou && <span className="bancada-spinner" aria-hidden />}
      <div>
        <strong>{falhou ? "A bancada não subiu." : "Ligando a bancada…"}</strong>
        <p>
          {falhou
            ? "Veja o motivo acima e tente recriar."
            : "Checkout, dev server, agente e navegador. Na primeira vez leva cerca de um minuto."}
        </p>
        {naFila && <p className="bancada-fila">Sua mensagem sai assim que ela abrir.</p>}
      </div>
    </div>
  );
}

function Esqueleto({ legenda }: { legenda?: string }) {
  return (
    <div className="bancada-esqueleto">
      <div className="bancada-esqueleto-barra" />
      <div className="bancada-esqueleto-bloco" />
      <div className="bancada-esqueleto-bloco is-curto" />
      {legenda && <span>{legenda}</span>}
    </div>
  );
}

/** Uma mensagem. A do humano é uma bolha; a do agente é a tela do CLI virada em
 *  blocos — cada tipo com a sua forma. */
function Mensagem({ role, content }: { role: "user" | "agent"; content: string }) {
  const blocos = useMemo(() => (role === "agent" ? parseAgentScreen(content) : []), [role, content]);

  if (role === "user") {
    return (
      <div className="bancada-msg is-voce">
        <div className="bancada-bolha">{content}</div>
      </div>
    );
  }

  return (
    <>
      {blocos.map((b, i) =>
        b.tipo === "eco" ? (
          // O pedido recuperado da tela do terminal. É a MESMA coisa que a
          // bolha otimista, então ele fica com a forma dela — e a deduplicação
          // acontece na lista, não aqui.
          <div key={i} className="bancada-msg is-voce">
            <div className="bancada-bolha">{b.linhas.join(" ")}</div>
          </div>
        ) : (
          <div key={i} className="bancada-msg is-agente">
            <BlocoView bloco={b} />
          </div>
        ),
      )}
    </>
  );
}

function BlocoView({ bloco }: { bloco: Bloco }) {
  const texto = bloco.linhas.join("\n");
  switch (bloco.tipo) {
    case "passo":
      return (
        <div className="bancada-passo">
          <span className="bancada-marcador" aria-hidden />
          <span>{texto}</span>
        </div>
      );
    case "detalhe":
      return <div className="bancada-detalhe">{texto}</div>;
    case "codigo":
      return (
        <pre className="bancada-codigo">
          <code>{texto}</code>
        </pre>
      );
    case "status":
      return <div className="bancada-status">{texto}</div>;
    default:
      return <p className="bancada-texto">{texto}</p>;
  }
}
