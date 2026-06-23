"use client";

import type { Subscription, User } from "@brokk/sdk";
import type React from "react";
import { useEffect, useState } from "react";
import {
  Main,
  PageHeader,
  StatStrip,
  Stat,
  Banner,
  EmptyState,
  Button,
} from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";

export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [gh, setGh] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectState | null>(null);

  const refresh = async () => {
    const [u, s] = await Promise.all([brokk.listUsers(), brokk.listSubscriptions()]);
    setUsers(u);
    setSubs(s);
  };

  useEffect(() => {
    setMounted(true);
    refresh().catch((e) => setErr(String(e)));
  }, []);

  if (!mounted) return null;

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await brokk.createUser({ name: name.trim(), email: email.trim(), githubLogin: gh.trim() || undefined });
      setName(""); setEmail(""); setGh("");
      await refresh();
    } catch (e) {
      setErr(String(e));
    }
  }

  const activeSeats = subs.filter((s) => s.status === "active").length;

  return (
    <Main style={{ maxWidth: "54rem" }}>
      <PageHeader
        title="Users & seats"
        description={
          <>
            Each member lends a <strong>Max seat</strong>; the forge spreads runs across them.
          </>
        }
      />

      {err && <Banner tone="err">⚠ {err}</Banner>}

      <StatStrip>
        <Stat value={users.length} label="Members" />
        <Stat value={subs.length} label="Seats connected" />
        <Stat value={activeSeats} label="Active seats" tone="ok" dot />
      </StatStrip>

      <form onSubmit={addUser} style={{ display: "flex", gap: 8, marginBottom: "1.4rem", flexWrap: "wrap" }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={{ ...field, flex: "0 1 160px" }} />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@coldcodelabs.com" style={{ ...field, flex: "1 1 220px" }} />
        <input value={gh} onChange={(e) => setGh(e.target.value)} placeholder="github (optional)" style={{ ...field, flex: "0 1 150px" }} />
        <Button type="submit" disabled={!name.trim() || !email.trim()}>Add member</Button>
      </form>

      {users.length === 0 ? (
        <EmptyState title="No members yet" description="Add a member above to lend their Max seat to the forge." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {users.map((u) => {
            const seats = subs.filter((s) => s.userId === u.id);
            return (
              <section key={u.id} className="ygg-card" style={{ animation: "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{u.name}</div>
                    <div className="ygg-dim" style={{ fontSize: 12 }}>
                      {u.email}{u.githubLogin ? ` · @${u.githubLogin}` : ""}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setConnect({ userId: u.id, step: "idle" })}>
                    + Connect Max seat
                  </Button>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                  {seats.length === 0 && <span className="ygg-dim" style={{ fontSize: 12 }}>no seats connected</span>}
                  {seats.map((s) => (
                    <span key={s.id} className="ygg-badge" data-tone={s.status === "active" ? "ok" : undefined}>
                      {s.label}{" "}
                      <span className="ygg-dim" style={{ fontFamily: "ui-monospace, monospace" }}>{s.tokenPreview}</span>
                    </span>
                  ))}
                </div>

                {connect?.userId === u.id && (
                  <ConnectFlow
                    state={connect}
                    setState={setConnect}
                    onDone={async () => { setConnect(null); await refresh(); }}
                  />
                )}
              </section>
            );
          })}
        </div>
      )}
    </Main>
  );
}

type ConnectState =
  | { userId: string; step: "idle" }
  | { userId: string; step: "started"; sessionId: string; url: string };

function ConnectFlow({
  state, setState, onDone,
}: {
  state: ConnectState;
  setState: (s: ConnectState | null) => void;
  onDone: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function start() {
    setBusy(true); setErr(null);
    try {
      const { sessionId, url } = await brokk.connectStart();
      window.open(url, "_blank", "noopener");
      setState({ userId: state.userId, step: "started", sessionId, url });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (state.step !== "started") return;
    setBusy(true); setErr(null);
    try {
      await brokk.connectComplete({ sessionId: state.sessionId, code: code.trim(), userId: state.userId });
      onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={panel}>
      {state.step === "idle" ? (
        <>
          <p style={pTxt}>
            Click to open Claude’s authorize page. Sign in with this member’s <strong>Max</strong> account,
            approve, then paste the code back here.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={start} disabled={busy}>{busy ? "Starting…" : "Open authorize page →"}</Button>
            <Button variant="outline" onClick={() => setState(null)}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          <p style={pTxt}>
            Authorize page opened.{" "}
            <a href={state.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>reopen ↗</a>{" "}
            — paste the code (looks like <code style={codeS}>abc…#xyz</code>):
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="paste code here" style={{ ...field, flex: "1 1 280px" }} />
            <Button onClick={finish} disabled={busy || code.trim().length < 4}>
              {busy ? "Sealing…" : "Connect seat"}
            </Button>
            <Button variant="outline" onClick={() => setState(null)}>Cancel</Button>
          </div>
        </>
      )}
      {err && <Banner tone="err" style={{ marginBottom: 0, marginTop: 8 }}>⚠ {err}</Banner>}
    </div>
  );
}

const field: React.CSSProperties = {
  background: "var(--bg-soft)",
  border: "1px solid var(--line)",
  borderRadius: "0.55rem",
  padding: "0.55rem 0.7rem",
  color: "var(--fg)",
  font: "inherit",
  fontSize: "0.9rem",
  minWidth: 120,
};
const panel: React.CSSProperties = {
  marginTop: 12,
  padding: 14,
  background: "var(--bg)",
  border: "1px solid var(--line-soft)",
  borderRadius: 9,
};
const pTxt: React.CSSProperties = { margin: "0 0 10px", fontSize: 13, color: "var(--fg)", lineHeight: 1.5 };
const codeS: React.CSSProperties = { background: "var(--bg-soft)", padding: "1px 5px", borderRadius: 4 };
