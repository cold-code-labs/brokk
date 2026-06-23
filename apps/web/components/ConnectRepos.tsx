"use client";

import type { RepoCandidate } from "@brokk/sdk";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Main,
  PageHeader,
  Banner,
  Button,
  EmptyState,
} from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";

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
    <Main style={{ maxWidth: "52rem" }}>
      <PageHeader
        title="Connect repos"
        description={
          <>
            Repos in <span style={{ color: "var(--fg)" }}>{org || "the org"}</span>{" "}
            not yet on the forge. Each one you connect gets a default project.
          </>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/">← Fleet</Link>
          </Button>
        }
      />

      {err && <Banner tone="err">⚠ {err}</Banner>}
      {done !== null && (
        <Banner tone="info">
          ✓ Connected {done} repo{done === 1 ? "" : "s"}.{" "}
          <Link href="/" style={{ color: "var(--accent)", textDecoration: "none" }}>
            Open the fleet →
          </Link>
        </Banner>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          style={{ ...field, flex: "0 0 240px" }}
        />
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          ↻ Refresh
        </Button>
        <span style={{ flex: 1 }} />
        <Button onClick={connect} disabled={busy || picked.size === 0}>
          {busy ? "Connecting…" : `Connect ${picked.size || ""} →`}
        </Button>
      </div>

      {loading && <p className="ygg-muted" style={{ fontSize: 13 }}>Listing repos via gh…</p>}
      {!loading && shown.length === 0 && (
        <EmptyState
          title="Nothing to connect"
          description="Every repo is already on the forge."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/">Open the fleet →</Link>
            </Button>
          }
        />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map((c) => {
          const on = picked.has(c.fullName);
          return (
            <button key={c.fullName} onClick={() => toggle(c.fullName)} style={row(on)}>
              <span style={{ ...check, ...(on ? checkOn : {}) }}>{on ? "✓" : ""}</span>
              <span style={{ display: "flex", flexDirection: "column", flex: 1, textAlign: "left", minWidth: 0 }}>
                <span style={{ fontSize: 13.5, color: "var(--fg)" }}>
                  {c.fullName}
                  {c.isArchived && <span style={{ fontSize: 11, color: "var(--fg-dim)" }}> · archived</span>}
                </span>
                {c.description && (
                  <span style={{ fontSize: 12, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.description}</span>
                )}
              </span>
              <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>{c.defaultBranch}</span>
            </button>
          );
        })}
      </div>
    </Main>
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
  minWidth: 140,
};
const check: React.CSSProperties = { width: 18, height: 18, borderRadius: 5, border: "1px solid var(--line-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#fff", flexShrink: 0 };
const checkOn: React.CSSProperties = { background: "var(--accent)", borderColor: "var(--accent)" };

function row(on: boolean): React.CSSProperties {
  return { display: "flex", alignItems: "center", gap: 11, width: "100%", background: on ? "var(--bg-soft)" : "var(--panel-2)", border: `1px solid ${on ? "var(--accent)" : "var(--line-soft)"}`, borderRadius: 9, padding: "10px 12px", cursor: "pointer" };
}
