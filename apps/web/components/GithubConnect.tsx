"use client";

import { useCallback, useEffect, useState } from "react";
import { Github, Loader2, Unplug } from "lucide-react";
import { Banner, Button } from "@cold-code-labs/yggdrasil-react";

/** ADR 0064 · per-org GitHub connection. Lets an org admin install the Brokk
 *  GitHub App on their own GitHub org/user, so the forge sees only the repos that
 *  installation authorizes. Talks to /api/github/* (proxied to brokk-api with the
 *  org claims injected server-side). */
type Installation = {
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
  suspended: boolean;
};
type Status = { ready: boolean; connected: boolean; installations: Installation[] };

export default function GithubConnect({ onChange }: { onChange?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/github/status");
      const d = (await r.json()) as Status;
      setStatus(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Land back here after the GitHub install (Setup URL → /github/setup → /connect).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("github");
    if (!p) return;
    if (p === "connected") {
      void refresh();
      onChange?.();
    } else if (p === "badstate") {
      setErr("O link de conexão expirou — tente conectar de novo.");
    } else if (p === "error") {
      setErr("Não consegui concluir a conexão com o GitHub. Tente de novo.");
    }
    // Clean the query so a refresh doesn't re-trigger.
    window.history.replaceState({}, "", window.location.pathname);
  }, [refresh, onChange]);

  async function connect() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/github/connect/start", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      window.location.href = d.url as string;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function disconnect(id: string) {
    if (!confirm("Desconectar este GitHub? A remoção definitiva do app é feita no github.com.")) return;
    setBusy(true);
    try {
      await fetch(`/api/github/installations/${id}`, { method: "DELETE" });
      await refresh();
      onChange?.();
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  if (!status.ready) {
    return (
      <Banner tone="warn">
        Conexão de GitHub indisponível neste deploy (o GitHub App não está configurado).
      </Banner>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      {err && (
        <Banner tone="err">
          <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ flex: 1, minWidth: 0 }}>{err}</span>
          </span>
        </Banner>
      )}
      {status.connected ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            border: "1px solid var(--line, #2a2a2a)",
            borderRadius: 12,
          }}
        >
          <Github size={18} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>GitHub conectado</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {status.installations
                .map((i) => `${i.accountLogin ?? i.installationId}${i.suspended ? " (suspenso)" : ""}`)
                .join(" · ")}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={connect} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Github size={14} />} Adicionar outra conta
          </Button>
          {status.installations.map((i) => (
            <Button
              key={i.installationId}
              variant="ghost"
              size="sm"
              onClick={() => disconnect(i.installationId)}
              disabled={busy}
            >
              <Unplug size={14} /> Desconectar {i.accountLogin ?? ""}
            </Button>
          ))}
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 12,
            padding: "14px 16px",
            border: "1px solid var(--line, #2a2a2a)",
            borderRadius: 12,
          }}
        >
          <Github size={18} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Conecte o GitHub da organização</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              Instale o app na sua conta do GitHub — o Brokk vê só os repositórios que você autorizar.
            </div>
          </div>
          <Button variant="default" size="sm" onClick={connect} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Github size={14} />} Conectar GitHub
          </Button>
        </div>
      )}
    </div>
  );
}
