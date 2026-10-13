import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT_WEB || 40190),
    host: "127.0.0.1",
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.PORT_API || 40191}` },
    },
  },
  build: { outDir: "dist" },
});
