"use client";

import type { RepoCandidate } from "@brokk/sdk";
import Link from "next/link";
import { useEffect, useState } from "react";
import { brokk } from "../lib/api";
import { STATUS_COLOR, t } from "../lib/theme";

/** gh-backed importer: list the org's repos, pick the ones to forge in, connect
 *  them in one shot (each gets a default project). */
export default function ConnectRepos() {
  const [org, setOrg] = useState("");
  const [candidates, setCandidates] = useState<RepoCandidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await brokk.importCandidates();
      setOrg(res.org);
      setCandidates(res.candidates);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  function toggle(fullName: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(fullName) ? next.delete(fullName) : next.add(fullName);
      return next;
    });
  }

  async function connect() {
    if (picked.size === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const repos = candidates
        .filter((c) => picked.has(c.fullName))
        .map((c) => ({ fullName: c.fullName, defaultBranch: c.defaultBranch }));
      const out = await brokk.importRepositories({ repos, createProject: true });
      setDone(out.length);
      setPicked(new Set());
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const shown = candidates.filter(
    (c) => !filter || c.fullName.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div style={{ padding: "28px 32px", maxWidth: 820 }}>
      <Link href="/" style={{ fontSize: 12, color: t.textMuted, textDecoration: "none" }}>← Fleet</Link>
      <h1 style={{ margin: "6px 0 0", fontSize: 22, letterSpacing: -0.4 }}>Connect repos</h1>
      <p style={{ margin: "4px 0 18px", color: t.textMuted, fontSize: 14 }}>
        Repos in <span style={{ color: t.text }}>{org || "the org"}</span> not yet on the forge. Each one you connect gets a default project.
      </p>

      {err && <p style={{ color: STATUS_COLOR.failed, fontSize: 13, margin: "0 0 12px" }}>⚠ {err}</p>}
      {done !== null && (
        <p style={{ color: STATUS_COLOR.done, fontSize: 13, margin: "0 0 12px" }}>
          ✓ Connected {done} repo{done === 1 ? "" : "s"}. <Link href="/" style={{ color: t.accent }}>Open the fleet →</Link>
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" style={input} />
        <button onClick={load} disabled={loading} style={btn}>↻ Refresh</button>
        <span style={{ flex: 1 }} />
        <button onClick={connect} disabled={busy || picked.size === 0} style={{ ...btn, ...(picked.size ? primary : {}) }}>
          {busy ? "Connecting…" : `Connect ${picked.size || ""} →`}
        </button>
      </div>

      {loading && <p style={{ color: t.textFaint, fontSize: 13 }}>Listing repos via gh…</p>}
      {!loading && shown.length === 0 && (
        <p style={{ color: t.textFaint, fontSize: 13 }}>Nothing to connect — every repo is already on the forge.</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map((c) => {
          const on = picked.has(c.fullName);
          return (
            <button key={c.fullName} onClick={() => toggle(c.fullName)} style={row(on)}>
              <span style={{ ...check, ...(on ? checkOn : {}) }}>{on ? "✓" : ""}</span>
              <span style={{ display: "flex", flexDirection: "column", flex: 1, textAlign: "left", minWidth: 0 }}>
                <span style={{ fontSize: 13.5, color: t.text }}>
                  {c.fullName}
                  {c.isArchived && <span style={{ fontSize: 11, color: t.textFaint }}> · archived</span>}
                </span>
                {c.description && (
                  <span style={{ fontSize: 12, color: t.textFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.description}</span>
                )}
              </span>
              <span style={{ fontSize: 11, color: t.textFaint }}>{c.defaultBranch}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const input: React.CSSProperties = { flex: "0 0 240px", background: t.surface, border: `1px solid ${t.border2}`, borderRadius: 8, padding: "8px 11px", color: t.text, fontSize: 13 };
const btn: React.CSSProperties = { background: t.surface3, border: `1px solid ${t.border2}`, color: t.textMuted, borderRadius: 8, padding: "8px 12px", fontSize: 13, cursor: "pointer" };
const primary: React.CSSProperties = { background: t.accent, color: "#fff" };
const check: React.CSSProperties = { width: 18, height: 18, borderRadius: 5, border: `1px solid ${t.border2}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#fff", flexShrink: 0 };
const checkOn: React.CSSProperties = { background: t.accent, borderColor: t.accent };

function row(on: boolean): React.CSSProperties {
  return { display: "flex", alignItems: "center", gap: 11, width: "100%", background: on ? t.surface3 : t.surface2, border: `1px solid ${on ? t.borderActive : t.border2}`, borderRadius: 9, padding: "10px 12px", cursor: "pointer" };
}
