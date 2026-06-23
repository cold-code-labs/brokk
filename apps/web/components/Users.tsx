"use client";

import type { Subscription, User } from "@brokk/sdk";
import { useEffect, useState } from "react";
import { brokk } from "../lib/api";
import { t } from "../lib/theme";

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

  return (
    <div style={{ padding: "28px 32px", maxWidth: 860 }}>
      <h1 style={{ margin: 0, fontSize: 22, letterSpacing: -0.4 }}>Users &amp; seats</h1>
      <p style={{ margin: "4px 0 20px", color: t.textMuted, fontSize: 14 }}>
        Each member lends a <strong>Max seat</strong>; the forge spreads runs across them.
      </p>

      <form onSubmit={addUser} style={{ display: "flex", gap: 8, marginBottom: 22, flexWrap: "wrap" }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={inp(160)} />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@coldcodelabs.com" style={inp(220)} />
        <input value={gh} onChange={(e) => setGh(e.target.value)} placeholder="github (optional)" style={inp(150)} />
        <button type="submit" disabled={!name.trim() || !email.trim()} style={btn(true)}>Add member</button>
      </form>

      {err && <p style={{ color: "#f85149", fontSize: 13 }}>⚠ {err}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {users.length === 0 && <p style={{ color: t.textFaint, fontSize: 13 }}>No members yet.</p>}
        {users.map((u) => {
          const seats = subs.filter((s) => s.userId === u.id);
          return (
            <section key={u.id} style={cardBox}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{u.name}</div>
                  <div style={{ fontSize: 12, color: t.textFaint }}>
                    {u.email}{u.githubLogin ? ` · @${u.githubLogin}` : ""}
                  </div>
                </div>
                <button onClick={() => setConnect({ userId: u.id, step: "idle" })} style={btn(false)}>
                  + Connect Max seat
                </button>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                {seats.length === 0 && <span style={{ fontSize: 12, color: t.textFaint }}>no seats connected</span>}
                {seats.map((s) => (
                  <span key={s.id} style={seat}>
                    <span style={{ ...dot, background: s.status === "active" ? "#2ea043" : t.textFaint }} />
                    {s.label} <span style={{ color: t.textFaint, fontFamily: "ui-monospace, monospace" }}>{s.tokenPreview}</span>
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
    </div>
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
            <button onClick={start} disabled={busy} style={btn(true)}>{busy ? "Starting…" : "Open authorize page →"}</button>
            <button onClick={() => setState(null)} style={btn(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p style={pTxt}>
            Authorize page opened.{" "}
            <a href={state.url} target="_blank" rel="noreferrer" style={{ color: t.accent }}>reopen ↗</a>{" "}
            — paste the code (looks like <code style={codeS}>abc…#xyz</code>):
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="paste code here" style={inp(280)} />
            <button onClick={finish} disabled={busy || code.trim().length < 4} style={btn(true)}>
              {busy ? "Sealing…" : "Connect seat"}
            </button>
            <button onClick={() => setState(null)} style={btn(false)}>Cancel</button>
          </div>
        </>
      )}
      {err && <p style={{ color: "#f85149", fontSize: 12, margin: "8px 0 0" }}>⚠ {err}</p>}
    </div>
  );
}

const cardBox: React.CSSProperties = { background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, padding: 16 };
const seat: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, background: t.surface2, border: `1px solid ${t.border2}`, borderRadius: 20, padding: "4px 10px" };
const dot: React.CSSProperties = { width: 7, height: 7, borderRadius: 7 };
const panel: React.CSSProperties = { marginTop: 12, padding: 14, background: t.inset, border: `1px solid ${t.border2}`, borderRadius: 9 };
const pTxt: React.CSSProperties = { margin: "0 0 10px", fontSize: 13, color: t.text, lineHeight: 1.5 };
const codeS: React.CSSProperties = { background: t.surface3, padding: "1px 5px", borderRadius: 4 };

function inp(w: number): React.CSSProperties {
  return { flex: `0 1 ${w}px`, minWidth: 120, background: t.surface, border: `1px solid ${t.border2}`, borderRadius: 8, padding: "8px 11px", color: t.text, fontSize: 13 };
}
function btn(primary: boolean): React.CSSProperties {
  return { background: primary ? t.accent : t.surface3, border: `1px solid ${t.border2}`, color: primary ? "#fff" : t.textMuted, borderRadius: 8, padding: "8px 13px", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" };
}
