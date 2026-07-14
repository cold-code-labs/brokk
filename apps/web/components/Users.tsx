"use client";

import type { Subscription, User } from "@brokk/sdk";
import type React from "react";
import { Fragment, useEffect, useState } from "react";
import { Users as CrewIcon } from "lucide-react";
import { Main, Banner, Button } from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { useToast } from "./Toaster";

export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [gh, setGh] = useState("");
  const toast = useToast();
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
      toast(`${name.trim()} joined the crew.`, { tone: "ok" });
      setName(""); setEmail(""); setGh("");
      await refresh();
    } catch (e) {
      toast("Could not add the member.", { meta: String(e), tone: "err" });
    }
  }

  const activeSeats = subs.filter((s) => s.status === "active").length;

  return (
    <Main className="forge-room is-crew">
      {/* masthead — the crew */}
      <header className="forge-head">
        <div className="forge-head-top">
          <div className="forge-head-copy">
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
                    <Button variant="outline" size="sm" onClick={() => setConnect({ userId: u.id })}>
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

type ConnectState = { userId: string };

function ConnectFlow({
  state, setState, onDone,
}: {
  state: ConnectState;
  setState: (s: ConnectState | null) => void;
  onDone: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function finish() {
    setBusy(true); setErr(null);
    try {
      await brokk.connectToken({ userId: state.userId, token: token.trim() });
      onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const looksValid = /^sk-ant-oat01-/.test(token.trim());

  return (
    <div>
      <p style={pTxt}>
        On your own machine, run <code style={codeS}>claude setup-token</code>, sign in with this
        member&rsquo;s <strong>Max</strong> account, and paste the token it prints (starts with{" "}
        <code style={codeS}>sk-ant-oat01…</code>). We seal it at rest — it&rsquo;s never shown again.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="paste sk-ant-oat01-… token"
          style={{ ...field, flex: "1 1 320px" }}
        />
        <Button onClick={finish} disabled={busy || !looksValid}>
          {busy ? "Connecting…" : "Connect seat"}
        </Button>
        <Button variant="outline" onClick={() => setState(null)}>Cancel</Button>
      </div>
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
