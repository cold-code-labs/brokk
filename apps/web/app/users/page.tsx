export default function UsersPage() {
  return (
    <div style={{ padding: "28px 32px", maxWidth: 760 }}>
      <h1 style={{ margin: 0, fontSize: 22, letterSpacing: -0.4 }}>Users &amp; seats</h1>
      <p style={{ margin: "4px 0 20px", color: "#9aa3b2", fontSize: 14 }}>
        Team members and the Max subscription each one lends to the forge.
      </p>
      <div style={{ background: "#0f121a", border: "1px solid #1c212c", borderRadius: 10, padding: 22 }}>
        <p style={{ margin: 0, color: "#9aa3b2", fontSize: 13, lineHeight: 1.6 }}>
          ⏳ Wiring in progress. Each user brings a <strong>Max subscription</strong> (an
          OAuth token from <code style={code}>claude setup-token</code>), which Brokk seals
          and forges under — spreading the rate-limit window across seats and attributing
          each run to whoever powered it.
        </p>
      </div>
    </div>
  );
}

const code: React.CSSProperties = { background: "#161c28", padding: "1px 6px", borderRadius: 5, fontSize: 12 };
