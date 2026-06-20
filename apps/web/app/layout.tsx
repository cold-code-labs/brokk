import type { ReactNode } from "react";
import Sidebar from "../components/Sidebar";

export const metadata = {
  title: "Brokk",
  description: "CCL's AI coding-agent platform — the forge.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
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
        <Sidebar />
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      </body>
    </html>
  );
}
