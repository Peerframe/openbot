import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Explicit opt-in entry; regular Web/Desktop builds keep their existing input unchanged. */
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist-client-fixtures",
    target: "es2022",
    rolldownOptions: { input: resolve(import.meta.dirname, "client-fixtures.html") },
  },
  preview: {
    host: "127.0.0.1",
    port: 5182,
    strictPort: true,
    headers: { "Permissions-Policy": "microphone=(), camera=(), geolocation=()" },
  },
});
