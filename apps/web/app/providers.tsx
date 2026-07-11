"use client";

import type { ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { ProjectProvider } from "../lib/project-context";
import { Toaster } from "../components/Toaster";

/**
 * Brokk is dark-native, so it defaults to dark — but the Yggdrasil tokens are
 * dual-mode, so the sidebar toggle flips to the cold-paper light theme.
 * enableSystem is off so an operator's OS preference doesn't silently change the
 * forge's chrome.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      <ProjectProvider>
        <Toaster>{children}</Toaster>
      </ProjectProvider>
    </ThemeProvider>
  );
}
