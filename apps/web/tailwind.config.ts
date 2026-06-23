import type { Config } from "tailwindcss";
import yggdrasil from "@cold-code-labs/yggdrasil-react/tailwind";

export default {
  presets: [yggdrasil],
  corePlugins: { preflight: false },
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./node_modules/@cold-code-labs/yggdrasil-react/src/**/*.{ts,tsx}",
    "../../node_modules/.pnpm/**/@cold-code-labs/yggdrasil-react/src/**/*.{ts,tsx}",
  ],
} satisfies Config;
