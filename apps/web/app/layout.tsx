import type { ReactNode } from "react";

export const metadata = {
  title: "Brokk",
  description: "CCL's AI coding-agent platform — the forge.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          background: "#0b0d12",
          color: "#e6e8ee",
        }}
      >
        {children}
      </body>
    </html>
  );
}
