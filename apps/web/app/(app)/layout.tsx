import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@cold-code-labs/yggdrasil-react";

import Topbar from "../../components/Topbar";
import { authEnabled, getSession } from "../../lib/logto";

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

  return (
    <AppShell className="forge-shell forge-shell--lintel">
      <Topbar
        user={{ name: session.name, role: session.role, authDisabled: session.authDisabled }}
      />
      <div className="forge-canvas">{children}</div>
    </AppShell>
  );
}
