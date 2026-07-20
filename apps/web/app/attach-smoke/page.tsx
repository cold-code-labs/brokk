/**
 * Public smoke surface for BROKK-38 acceptance — chat is Logto-gated, so this
 * route mirrors the composer attach affordance (drop zone + Attach chip) without
 * a live session. Acceptance drives Chromium here.
 */
export default function AttachSmokePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
        background: "var(--bg, #0b0d12)",
        color: "var(--fg, #e8eaef)",
        fontFamily: "var(--font-inter), system-ui, sans-serif",
      }}
    >
      <div
        className="sindri-composer"
        data-sindri-attach="1"
        style={{
          width: "min(520px, 100%)",
          border: "1px solid var(--line-soft, #2a2f3a)",
          borderRadius: 12,
          padding: "0.75rem",
        }}
      >
        <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", opacity: 0.8 }}>
          Composer attach → <code>.brokk/inbox/</code>
        </p>
        <ul className="sindri-attach-list" aria-label="Attachments">
          <li className="sindri-attach-chip">
            <span>fixture-costs.txt</span>
          </li>
        </ul>
        <button
          type="button"
          className="sindri-chip sindri-attach-btn"
          data-testid="sindri-attach"
          title="Attach file (xlsx / pdf / txt) → .brokk/inbox/"
        >
          Attach
        </button>
      </div>
    </main>
  );
}
