"use client";

import type { ComponentType, ReactNode } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { ProjectProvider } from "../lib/project-context";
import { Toaster } from "../components/Toaster";

/** next-themes typings lag React 19 (`children` missing on ThemeProviderProps). */
const ThemeProvider = NextThemesProvider as ComponentType<{
  children?: ReactNode;
  attribute?: string;
  defaultTheme?: string;
  enableSystem?: boolean;
  disableTransitionOnChange?: boolean;
}>;

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
