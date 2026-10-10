/** Loads the existing Web dev configuration and binds its proxy to the Server's exact Host. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const target = process.env.OPENBOT_DEV_API_URL;
assert(target, "The dev Server must supply its explicit local origin.");
const url = new URL(target);
assert(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
  !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
  "The dev proxy requires an explicit loopback HTTP Server.");
// Vite's inline config merges with apps/web/vite.config.ts. Only the development transport Host
// changes; the browser Origin is preserved for the actual Server's existing CSRF checks.
const server = await createServer({
  root: fileURLToPath(new URL("../apps/web", import.meta.url)),
  server: { strictPort: true, proxy: {
    "/api": { target, changeOrigin: true }, "/health": { target, changeOrigin: true },
  } },
});
const stop = () => { void server.close().catch(() => { process.exitCode = 1; }); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try { await server.listen(); server.printUrls(); }
catch (error) { await server.close(); throw error; }
