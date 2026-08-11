import type { ReactNode } from "react";
import { Big_Shoulders, DM_Sans, IBM_Plex_Mono, Inter, JetBrains_Mono } from "next/font/google";
import "@cold-code-labs/yggdrasil-tokens/css";
import "@cold-code-labs/yggdrasil-react/shell.css";
import "streamdown/styles.css";
import "./globals.css";
import "./forge.css";
import { Providers } from "./providers";

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
/* House workshop voice (scoped via --font-house / --font-house-mono). */
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-house",
  display: "swap",
});
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-house-mono",
  display: "swap",
});
/* The display voice of the forge: condensed industrial grotesk — stamped
 * steel for mastheads and numerals. Body stays Inter; data stays mono. */
const bigShoulders = Big_Shoulders({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

export const metadata = {
  title: "Brokk — the forge for autonomous coding agents",
  description:
    "Card → agent forges the code → Pull Request. Brokk runs a fleet of isolated coding agents over your repos — Mímir advises, Brokkr forges, Eitri reviews. Open source, Apache-2.0.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrains.variable} ${bigShoulders.variable} ${dmSans.variable} ${ibmPlexMono.variable}`}
    >
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
