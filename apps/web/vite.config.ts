import { randomBytes } from "node:crypto";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { rewriteIndexHtmlCspForDev, WEB_DEV_CSP_NONCE_PLACEHOLDER } from "./src/dev-csp-nonce";
import { pluginProxyDocument } from "./src/plugin-app-sandbox";

function pluginSandboxDocument(): Plugin {
  return {
    name: "openbot-plugin-sandbox-document",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "plugin-sandbox.html",
        source: pluginProxyDocument(),
      });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/plugin-sandbox.html") return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(pluginProxyDocument());
      });
    },
  };
}

/**
 * Serve-only: align the meta CSP with Vite `html.cspNonce` so injected CSS/JS
 * are allowed without `'unsafe-inline'`. Not registered for build or Desktop.
 */
function pluginDevCspNonce(): Plugin {
  return {
    name: "openbot-web-dev-csp-nonce",
    apply: "serve",
    configureServer(server) {
      const transformIndexHtml = server.transformIndexHtml.bind(server);
      // Vite stamps nonce attributes after every user HTML hook. Finalize the
      // response only after that pipeline, without changing shared Vite config.
      server.transformIndexHtml = async (url, html, originalUrl) => {
        const transformed = await transformIndexHtml(url, html, originalUrl);
        if (url !== "/index.html") return transformed;
        return rewriteIndexHtmlCspForDev(transformed, randomBytes(24).toString("base64"));
      };
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const desktopRenderer = mode === "desktop";
  const apiTarget = process.env.OPENBOT_DEV_API_URL ?? "http://localhost:3001";
  const target = new URL(apiTarget);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.protocol !== "http:" ||
      target.username || target.password || target.pathname !== "/" || target.search || target.hash)
    throw new Error("OPENBOT_DEV_API_URL must select an explicit loopback HTTP service.");
  // Only the standard web development document receives response-specific nonces.
  const enableDevCspNonce = command === "serve" && !desktopRenderer;

  return {
    ...(desktopRenderer
      ? {
          base: "./",
          build: {
            emptyOutDir: true,
            outDir: "../desktop/dist/renderer",
          },
        }
      : {}),
    ...(enableDevCspNonce
      ? {
          html: { cspNonce: WEB_DEV_CSP_NONCE_PLACEHOLDER },
        }
      : {}),
    plugins: [
      react(),
      pluginSandboxDocument(),
      ...(enableDevCspNonce ? [pluginDevCspNonce()] : []),
    ],
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        "/api": apiTarget,
        "/health": apiTarget,
      },
    },
  };
});
