import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import Sidebar from "../components/Sidebar";
import { authEnabled, getSession } from "../lib/logto";

export const metadata = {
  title: "Brokk",
  description: "CCL's AI coding-agent platform — the forge.",
};

// Auth is enforced per-request in this layout (getSession reads cookies + the
// runtime LOGTO_* env). Force dynamic rendering so the gate is never baked into a
// static prerender — otherwise a build without LOGTO_* set would ship the open
// (unauthenticated) shell as static HTML, bypassing login at runtime.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (authEnabled && !session.isAuthenticated) {
    redirect("/sign-in");
  }

  return (
    <html lang="en">
      <body
        suppressHydrationWarning
        style={{
          margin: 0,
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          background: "#0b0d12",
          color: "#e6e8ee",
          display: "flex",
          minHeight: "100vh",
        }}
      >
        <Sidebar
          user={{ name: session.name, role: session.role, authDisabled: session.authDisabled }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      </body>
    </html>
  );
}
