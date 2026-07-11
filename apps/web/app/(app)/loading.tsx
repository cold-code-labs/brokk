/** Route-transition skeleton — the metal heating while the room loads.
 *  Ghost of the canonical page anatomy (nameplate → vitals → ledger) so
 *  navigation always answers instantly instead of freezing the sidebar. */
export default function Loading() {
  return (
    <main className="ygg-main" style={{ maxWidth: "74rem" }}>
      <div className="forge-skeleton" style={{ width: "9rem", height: "0.8rem", marginBottom: "0.8rem" }} />
      <div className="forge-skeleton" style={{ width: "22rem", height: "2.6rem", marginBottom: "0.7rem" }} />
      <div className="forge-skeleton" style={{ width: "15rem", height: "0.9rem", marginBottom: "1.6rem" }} />
      <div className="forge-skeleton" style={{ width: "100%", height: "5.6rem", marginBottom: "1.6rem" }} />
      <div className="forge-skeleton" style={{ width: "100%", height: "13rem" }} />
    </main>
  );
}
