import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Design preview (dev only): the real UI on synthetic data for 1:1 artboard screenshots. There is
// no build step for it, so it can never ship; `preview.html` sets `connect-src 'none'`.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5179,
    strictPort: true,
    hmr: false,
    open: false,
  },
});
