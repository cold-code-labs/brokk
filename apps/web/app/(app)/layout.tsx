import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@cold-code-labs/yggdrasil-react";

import Sidebar from "../../components/Sidebar";
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
    <AppShell>
      <Sidebar
        user={{ name: session.name, role: session.role, authDisabled: session.authDisabled }}
      />
      <div style={{ minWidth: 0 }}>{children}</div>
    </AppShell>
  );
}
