"use client";

import type { RepoCandidate } from "@brokk/sdk";
import Link from "next/link";
import { useEffect, useState } from "react";
import { DoorOpen } from "lucide-react";
import {
  Main,
  Banner,
  Button,
} from "@cold-code-labs/yggdrasil-react";
import { brokk } from "../lib/api";
import { useToast } from "./Toaster";
import { useProject } from "../lib/project-context";

/** gh-backed importer: list the org's repos, pick the ones to forge in, connect
 *  them in one shot (each gets a default project). */
export default function ConnectRepos() {
  const [org, setOrg] = useState("");
  const [candidates, setCandidates] = useState<RepoCandidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const { refresh, setCurrentId } = useProject();

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await brokk.importCandidates();
      setOrg(res.org);
      setCandidates(res.candidates);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
      toast(`${out.length} repo${out.length === 1 ? "" : "s"} connected — doors on the wall.`, { tone: "ok" });
      setPicked(new Set());
      // Surface the new project in the global switcher immediately (no hard
      // reload) and select the one we just connected, so the operator lands
      // straight in its environment instead of dropping to "no env selected".
      refresh();
      try {
        const repoIds = new Set(out.map((r) => r.id));
        const proj = (await brokk.listProjects()).find((p) => repoIds.has(p.repositoryId));
        if (proj) setCurrentId(proj.id);
      } catch {
        /* best-effort: the switcher still refreshed above */
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const shown = candidates.filter(
    (c) => !filter || c.fullName.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <Main style={{ maxWidth: "52rem" }}>
      {/* ── masthead: the doors ── */}
      <header className="forge-head">
        <div className="forge-head-top">
          <div>
            <span className="forge-eyebrow">Brokk · the doors</span>
            <h1 className="forge-title">Connect repos</h1>
            <p className="forge-sub">
              Repos in <span style={{ color: "var(--fg)" }}>{org || "the org"}</span> not yet at the
              forge. Each connected repo gets a default project.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/fleet">← Fleet</Link>
          </Button>
        </div>
        <div className="forge-head-rule" />
      </header>

      {err && (
        <Banner tone="err">
          <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ flex: 1, minWidth: 0 }}>{humanizeErr(err)}</span>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              Retry
            </Button>
          </span>
        </Banner>
      )}
      {done !== null && (
        <Banner tone="info">
          {done} repo{done === 1 ? "" : "s"} connected.{" "}
          <Link href="/fleet" style={{ color: "var(--accent)", textDecoration: "none" }}>
            Open the fleet →
          </Link>
        </Banner>
      )}

      {/* ── command bar: filter + connect ── */}
      <div className="forge-bar" style={{ marginBottom: 14 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter repos…"
          aria-label="Filter repos"
        />
        <button
          type="button"
          className="forge-bar-send"
          onClick={connect}
          disabled={busy || picked.size === 0}
        >
          {busy ? "Connecting…" : picked.size > 0 ? `Connect ${picked.size}` : "Connect"}
        </button>
      </div>

      <div className="forge-h">
        <span className="forge-h-title">Repos</span>
        <span className="forge-h-meta">
          {filter ? `${shown.length} of ${candidates.length}` : candidates.length}
        </span>
        <span className="forge-h-rule" />
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          Refresh
        </Button>
      </div>

      {loading && <p className="ygg-dim" style={{ fontSize: 13 }}>Listing repos…</p>}
      {!loading && shown.length === 0 && (
        candidates.length === 0 ? (
          <div className="forge-empty is-panel">
            <span className="forge-empty-mark"><DoorOpen /></span>
            <span className="forge-empty-title">Every door is open</span>
            <p className="forge-empty-sub">
              Each repo in {org || "the org"} is already connected to the forge.
            </p>
            <span className="forge-empty-action">
              <Button asChild variant="outline" size="sm">
                <Link href="/fleet">Open the fleet</Link>
              </Button>
            </span>
          </div>
        ) : (
          <p className="ygg-dim" style={{ fontSize: 13 }}>
            0 of {candidates.length} match “{filter}”.
          </p>
        )
      )}

      {shown.length > 0 && (
        <div className="forge-ledger">
          {shown.map((c) => {
            const on = picked.has(c.fullName);
            return (
              <button
                key={c.fullName}
                type="button"
                onClick={() => toggle(c.fullName)}
                aria-pressed={on}
                className="forge-row"
                style={rowReset(on)}
              >
                <span style={{ ...check, ...(on ? checkOn : {}) }}>{on ? "✓" : ""}</span>
                <span style={{ display: "flex", flexDirection: "column", flex: 1, textAlign: "left", minWidth: 0 }}>
                  <span
                    className="forge-row-mono"
                    style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {c.fullName}
                    {c.isArchived && <span style={{ color: "var(--fg-dim)" }}> · archived</span>}
                  </span>
                  {c.description && (
                    <span style={{ fontSize: 12, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.description}
                    </span>
                  )}
                </span>
                <span className="forge-row-meta">{c.defaultBranch}</span>
              </button>
            );
          })}
        </div>
      )}
    </Main>
  );
}

/** Turn a raw SDK/proxy error into a line that names what broke and the next
 *  move. Transient gateway hiccups (502/504/unreachable, or a `gh` timeout) get
 *  a retry framing instead of a stack-trace dump; anything unexpected falls
 *  through verbatim (trimmed). */
function humanizeErr(raw: string): string {
  if (/502|504|bad gateway|unreachable|restarting|timed out|timeout/i.test(raw)) {
    return "Could not list repos — the gateway is restarting or unreachable. Retry in a moment.";
  }
  if (/gh repo list failed|unauthorized|401|403|auth/i.test(raw)) {
    return "GitHub refused the gh call (auth or access). Check the org token, then retry.";
  }
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

/** Neutralize the UA button chrome so `.forge-row` reads as a ledger row: kill
 *  the top/left/right borders only (the class supplies the bottom hairline) and
 *  keep the picked state on an accent tint — never the ember (that's running
 *  work). All color via tokens. */
function rowReset(on: boolean): React.CSSProperties {
  return {
    width: "100%",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    borderTop: 0,
    borderLeft: 0,
    borderRight: 0,
    background: on ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "transparent",
  };
}

const check: React.CSSProperties = { width: 18, height: 18, borderRadius: "var(--radius-sm)", border: "1px solid var(--line-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--primary-foreground)", flexShrink: 0 };
const checkOn: React.CSSProperties = { background: "var(--accent)", borderColor: "var(--accent)" };
