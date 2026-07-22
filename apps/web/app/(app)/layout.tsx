import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@cold-code-labs/yggdrasil-react";

import Topbar from "../../components/Topbar";
import { authEnabled, getSession } from "../../lib/logto";
import { orgTenancyEnabled } from "../../lib/rbac";

// Auth is enforced per-request for the whole console (getSession reads cookies +
// the runtime LOGTO_* env). Force dynamic rendering so the gate is never baked
// into a static prerender — otherwise a build without LOGTO_* set would ship the
// open (unauthenticated) shell as static HTML, bypassing login at runtime. The
// public landing at `/` lives outside this group and stays reachable to everyone.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (authEnabled && !session.isAuthenticated) {
    redirect("/sign-in");
  }

  // ADR 0064 T0: fail-closed for client-org members until board filters (T2) are
  // live behind BROKK_ORG_TENANCY=1. Staff always enters.
  if (authEnabled && session.isAuthenticated && !session.isCclStaff && !orgTenancyEnabled) {
    return (
      <AppShell className="forge-shell forge-shell--lintel">
        <Topbar
          user={{ name: session.name, role: session.role, authDisabled: session.authDisabled }}
        />
        <div className="forge-canvas">
          <main style={{ maxWidth: 36 * 16, margin: "4rem auto", padding: "0 1.5rem" }}>
            <h1 style={{ fontSize: "1.25rem", marginBottom: "0.75rem" }}>Acesso ainda não liberado</h1>
            <p style={{ lineHeight: 1.5, opacity: 0.85 }}>
              O Brokk da frota CCL só abre para membros de organização-cliente depois que o
              board filtra por org (ADR 0064). Enquanto isso, a CCL opera a fábrica com você
              no copiloto — preview e prod do seu projeto seguem pelo fluxo assistido.
            </p>
          </main>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell className="forge-shell forge-shell--lintel">
      <Topbar
        user={{ name: session.name, role: session.role, authDisabled: session.authDisabled }}
      />
      <div className="forge-canvas">{children}</div>
    </AppShell>
  );
}
