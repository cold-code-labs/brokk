import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Inter, JetBrains_Mono } from "next/font/google";
import "@cold-code-labs/yggdrasil-tokens/css";
import "@cold-code-labs/yggdrasil-react/shell.css";
import "streamdown/styles.css";
import "./globals.css";
import { AppShell } from "@cold-code-labs/yggdrasil-react";
import { Providers } from "./providers";
import Sidebar from "../components/Sidebar";
import { authEnabled, getSession } from "../lib/logto";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

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
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrains.variable}`}
    >
      <body suppressHydrationWarning>
        <Providers>
          <AppShell>
            <Sidebar
              user={{ name: session.name, role: session.role, authDisabled: session.authDisabled }}
            />
            <div style={{ minWidth: 0 }}>{children}</div>
          </AppShell>
        </Providers>
      </body>
    </html>
  );
}
