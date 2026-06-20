const COLUMNS = [
  { key: "backlog", label: "Backlog" },
  { key: "queued", label: "Queued" },
  { key: "running", label: "Running" },
  { key: "review", label: "Review (PR)" },
  { key: "done", label: "Done" },
] as const;

/**
 * Placeholder Kanban board. P2 wires this to the API via @brokk/sdk
 * (columns from tasks, live run log via SSE). For now it's static scaffolding.
 */
export default function BoardPage() {
  return (
    <main style={{ padding: "32px", maxWidth: 1200, margin: "0 auto" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28, letterSpacing: -0.5 }}>🔨 Brokk</h1>
        <p style={{ margin: "6px 0 0", color: "#9aa3b2" }}>
          The forge — card → agent → PR. <em>Board UI is P2 (placeholder).</em>
        </p>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${COLUMNS.length}, 1fr)`, gap: 12 }}>
        {COLUMNS.map((col) => (
          <section
            key={col.key}
            style={{
              background: "#12151c",
              border: "1px solid #1f2430",
              borderRadius: 10,
              padding: 12,
              minHeight: 320,
            }}
          >
            <h2 style={{ fontSize: 13, textTransform: "uppercase", color: "#9aa3b2", margin: "0 0 10px" }}>
              {col.label}
            </h2>
            <p style={{ fontSize: 12, color: "#5c6575" }}>—</p>
          </section>
        ))}
      </div>
    </main>
  );
}
