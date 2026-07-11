"use client";

import type { Subscription, User } from "@brokk/sdk";
import type React from "react";
import { Fragment, useEffect, useState } from "react";
import { Users as CrewIcon } from "lucide-react";
import { Main, Banner, Button } from "@cold-code-labs/yggdrasil-react";
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
      {/* masthead — the crew */}
      <header className="forge-head">
        <div className="forge-head-top">
          <div>
            <span className="forge-eyebrow">Brokk · the crew</span>
            <h1 className="forge-title">Crew</h1>
            <p className="forge-sub">Each member lends a Max seat. The forge spreads runs across them.</p>
          </div>
        </div>
        <div className="forge-head-rule" />
      </header>

      {err && <Banner tone="err">{err}</Banner>}

      {/* vitals */}
      <div className="forge-tiles">
        <div className="forge-tile">
          <div className="forge-tile-num">{users.length}</div>
          <div className="forge-tile-label">Members</div>
        </div>
        <div className="forge-tile">
          <div className="forge-tile-num">{subs.length}</div>
          <div className="forge-tile-label">Seats connected</div>
        </div>
        <div className={`forge-tile${activeSeats > 0 ? " is-live" : ""}`}>
          <div className="forge-tile-num">{activeSeats}</div>
          <div className="forge-tile-label">Active seats</div>
          <span className="forge-tile-spark" />
        </div>
      </div>

      {/* one command-bar: add a member */}
      <form onSubmit={addUser} className="forge-bar" style={{ marginBottom: "1.6rem" }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          style={{ flex: "0 1 10rem" }}
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email@coldcodelabs.com"
          style={{ borderLeft: "1px solid var(--line-soft)" }}
        />
        <input
          value={gh}
          onChange={(e) => setGh(e.target.value)}
          placeholder="github (optional)"
          style={{ flex: "0 1 10rem", borderLeft: "1px solid var(--line-soft)" }}
        />
        <button type="submit" className="forge-bar-send" disabled={!name.trim() || !email.trim()}>
          Add member
        </button>
      </form>

      {users.length === 0 ? (
        <div className="forge-empty is-panel">
          <span className="forge-empty-mark"><CrewIcon /></span>
          <span className="forge-empty-title">No crew yet</span>
          <p className="forge-empty-sub">
            People you invite work the forge with you. Add a member above to lend their seat.
          </p>
        </div>
      ) : (
        <>
          <div className="forge-h">
            <span className="forge-h-title">Members</span>
            <span className="forge-h-meta">{users.length}</span>
            <span className="forge-h-rule" />
          </div>
          <div className="forge-ledger">
            {users.map((u) => {
              const seats = subs.filter((s) => s.userId === u.id);
              return (
                <Fragment key={u.id}>
                  <div className="forge-row">
                    <span className="forge-row-title" style={{ flex: "0 1 auto" }}>{u.name}</span>
                    {seats.length === 0 ? (
                      <span className="forge-row-meta">0 seats</span>
                    ) : (
                      seats.map((s) => (
                        <span key={s.id} className={`forge-chip${s.status === "active" ? " is-accent" : ""}`}>
                          {s.label}
                          <span className="forge-row-mono">{s.tokenPreview}</span>
                        </span>
                      ))
                    )}
                    <span className="forge-row-mono" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>
                      {u.email}{u.githubLogin ? ` · @${u.githubLogin}` : ""}
                    </span>
                    <Button variant="outline" size="sm" onClick={() => setConnect({ userId: u.id, step: "idle" })}>
                      Connect seat
                    </Button>
                  </div>
                  {connect?.userId === u.id && (
                    <div style={connectWrap}>
                      <ConnectFlow
                        state={connect}
                        setState={setConnect}
                        onDone={async () => { setConnect(null); await refresh(); }}
                      />
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        </>
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
    <div>
      {state.step === "idle" ? (
        <>
          <p style={pTxt}>
            Opens Claude&rsquo;s authorize page. Sign in with this member&rsquo;s <strong>Max</strong> account,
            approve, and paste the code back here.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={start} disabled={busy}>{busy ? "Opening…" : "Open authorize page"}</Button>
            <Button variant="outline" onClick={() => setState(null)}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          <p style={pTxt}>
            Authorize page opened —{" "}
            <a href={state.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>reopen ↗</a>.{" "}
            Paste the code (looks like <code style={codeS}>abc…#xyz</code>):
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="paste code here" style={{ ...field, flex: "1 1 280px" }} />
            <Button onClick={finish} disabled={busy || code.trim().length < 4}>
              {busy ? "Connecting…" : "Connect seat"}
            </Button>
            <Button variant="outline" onClick={() => setState(null)}>Cancel</Button>
          </div>
        </>
      )}
      {err && <Banner tone="err" style={{ marginBottom: 0, marginTop: 8 }}>{err}</Banner>}
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
/* The connect flow lives inside the ledger, one shade deeper than the rows. */
const connectWrap: React.CSSProperties = {
  padding: "0.9rem 1.1rem",
  background: "var(--bg-soft)",
  borderBottom: "1px solid var(--line-soft)",
};
const pTxt: React.CSSProperties = { margin: "0 0 10px", fontSize: 13, color: "var(--fg)", lineHeight: 1.5 };
const codeS: React.CSSProperties = { background: "var(--bg)", padding: "1px 5px", borderRadius: 4 };
