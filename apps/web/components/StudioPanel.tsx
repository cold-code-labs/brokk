import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Database, RotateCw, Table2 } from "lucide-react";
import {
  studio,
  type StudioOverview,
  type StudioRows,
  type StudioTable,
} from "../lib/studio";

/** Render a Postgres cell value as compact text for the grid. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Read-only mini-Studio (ADR 0012 · P0): the Hauldr database behind a Sindri
 * preview — a table list on the left, a page of rows on the right. No writes, no
 * provisioning yet. Keyed by the preview id; renders a hero when there's no db.
 */
export function StudioPanel({ previewId }: { previewId: string | null }) {
  const [overview, setOverview] = useState<StudioOverview | null>(null);
  const [tables, setTables] = useState<StudioTable[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<StudioRows | null>(null);
  const [loading, setLoading] = useState(false);
  const [rowsBusy, setRowsBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    if (!previewId) return;
    setErr("");
    setLoading(true);
    try {
      const ov = await studio.overview(previewId);
      setOverview(ov);
      if (ov.connected) {
        const tb = await studio.tables(previewId);
        setTables(tb);
        setSelected((cur) => cur ?? tb[0]?.name ?? null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [previewId]);

  // (Re)load whenever the preview changes.
  useEffect(() => {
    setOverview(null);
    setTables(null);
    setSelected(null);
    setData(null);
    void load();
  }, [load]);

  // Fetch the selected table's page.
  useEffect(() => {
    if (!previewId || !selected) {
      setData(null);
      return;
    }
    let cancelled = false;
    setRowsBusy(true);
    studio
      .rows(previewId, selected)
      .then(
        (d) => {
          if (!cancelled) setData(d);
        },
        (e) => {
          if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
        },
      )
      .finally(() => {
        if (!cancelled) setRowsBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewId, selected]);

  const hero = (title: string, sub?: string) => (
    <div className="studio-hero">
      <div className="studio-hero-mark">
        <Database size={26} strokeWidth={1.4} />
      </div>
      <p>{title}</p>
      {sub ? <span className="studio-hero-sub">{sub}</span> : null}
    </div>
  );

  let body: ReactNode;
  if (!previewId) {
    body = hero("No preview running", "Start the preview and the database connects here.");
  } else if (loading && !overview) {
    body = (
      <div className="studio-hero">
        <span className="sindri-spinner" />
        <p>Connecting…</p>
      </div>
    );
  } else if (overview && !overview.connected) {
    const reasonSub =
      overview.reason === "no-database"
        ? "No Hauldr database on this project yet. Provisioning lands here soon."
        : overview.reason === "studio-disabled"
          ? "Studio is not configured — HAULDR_CONTROL_URL is unset."
          : overview.error || "Database unreachable.";
    body = hero("No database connected", reasonSub);
  } else if (overview?.connected) {
    body = (
      <div className="studio-split">
        <aside className="studio-tables">
          <div className="studio-tables-head">
            <span>Tables</span>
            <span className="studio-count">{tables?.length ?? 0}</span>
          </div>
          <ul>
            {(tables ?? []).map((tb) => (
              <li key={tb.name}>
                <button
                  type="button"
                  className={`studio-table-item ${selected === tb.name ? "is-on" : ""}`}
                  onClick={() => setSelected(tb.name)}
                >
                  <Table2 size={13} />
                  <span className="studio-table-name">{tb.name}</span>
                  <span className="studio-table-rows">{tb.rows}</span>
                </button>
              </li>
            ))}
            {tables && tables.length === 0 ? (
              <li className="studio-empty">0 tables in the public schema.</li>
            ) : null}
          </ul>
        </aside>
        <div className="studio-grid-wrap">
          {rowsBusy && !data ? (
            <div className="studio-hero">
              <span className="sindri-spinner" />
            </div>
          ) : data ? (
            <>
              <div className="studio-grid-scroll">
                <table className="studio-grid">
                  <thead>
                    <tr>
                      {data.columns.map((col) => (
                        <th key={col.name} title={col.type}>
                          {col.name}
                          <span className="studio-col-type">{col.type}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row, i) => (
                      <tr key={i}>
                        {data.columns.map((col) => (
                          <td key={col.name} title={cell(row[col.name])}>
                            {cell(row[col.name])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.rows.length === 0 ? <div className="studio-empty">0 rows.</div> : null}
              </div>
              <div className="studio-grid-foot">
                {data.rows.length} row{data.rows.length === 1 ? "" : "s"}
                {data.hasMore ? " · first page" : ""} · read-only
              </div>
            </>
          ) : (
            hero("Pick a table")
          )}
        </div>
      </div>
    );
  } else {
    body = hero("Database", err || "");
  }

  return (
    <div className="studio-panel">
      <div className="studio-bar">
        <span className="studio-bar-title">
          <Database size={13} />
          {overview?.connected ? overview.database || overview.hauldrProject : "Database"}
        </span>
        {overview?.connected ? (
          <span className="studio-bar-meta">{overview.tableCount ?? 0} tables · read-only</span>
        ) : null}
        <button
          type="button"
          className="sindri-preview-icon"
          title="Reload"
          onClick={() => void load()}
          disabled={!previewId || loading}
        >
          <RotateCw size={14} />
        </button>
      </div>
      {err && overview?.connected ? <div className="studio-err">{err}</div> : null}
      {body}
    </div>
  );
}
