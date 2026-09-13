import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import {
  rewriteIndexHtmlCspForDev,
  WEB_DEV_CSP_NONCE,
} from "./src/dev-csp-nonce";
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
function pluginDevCspNonce(nonce: string): Plugin {
  return {
    name: "openbot-web-dev-csp-nonce",
    apply: "serve",
    transformIndexHtml(html) {
      return rewriteIndexHtmlCspForDev(html, nonce);
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const desktopRenderer = mode === "desktop";
  // Fixed nonce is documented as local-dev-only; production/Desktop keep index.html CSP.
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
          html: { cspNonce: WEB_DEV_CSP_NONCE },
        }
      : {}),
    plugins: [
      react(),
      pluginSandboxDocument(),
      ...(enableDevCspNonce ? [pluginDevCspNonce(WEB_DEV_CSP_NONCE)] : []),
    ],
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        "/api": "http://localhost:3001",
        "/health": "http://localhost:3001",
      },
    },
  };
});
