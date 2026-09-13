import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, resolveConfig, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  rewriteIndexHtmlCspForDev,
  WEB_APP_PRODUCTION_CSP,
  WEB_DEV_CSP_NONCE_PLACEHOLDER,
  withDevCspNonces,
} from "./dev-csp-nonce";
import { pluginProxyDocument } from "./plugin-app-sandbox";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configFile = resolve(webRoot, "vite.config.ts");
const indexHtml = readFileSync(resolve(webRoot, "index.html"), "utf8");
const testNonce = "B7ddoW7dxgZhhoTZfjsh5QPjpHUaNbaP3";

function extractCspContent(html: string): string {
  const match = html.match(
    /<meta\b[^>]*\bhttp-equiv=(["'])Content-Security-Policy\1[^>]*\bcontent=(["'])([\s\S]*?)\2/iu,
  );
  if (!match?.[3]) throw new Error("CSP meta content missing");
  return match[3];
}

function assertServedNonce(html: string): string {
  const nonce = html.match(/<meta property="csp-nonce" nonce="([^"]+)"/u)?.[1];
  expect(nonce).toMatch(/^[A-Za-z0-9+/]{32}$/u);
  if (!nonce) throw new Error("Vite nonce meta missing");
  const csp = extractCspContent(html);
  expect(csp).toBe(withDevCspNonces(WEB_APP_PRODUCTION_CSP, nonce));
  expect(html).not.toContain(WEB_DEV_CSP_NONCE_PLACEHOLDER);
  expect(html).not.toContain("openbot-vite-dev-csp-nonce");
  expect(csp).not.toContain("unsafe-inline");
  const resourceTags = html.match(/<(?:script|style|link)\b[^>]*>/gu) ?? [];
  expect(resourceTags.length).toBeGreaterThanOrEqual(6);
  for (const tag of resourceTags) expect(tag).toContain(`nonce="${nonce}"`);
  expect(html.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(
    html.indexOf("<script"),
  );
  expect(html).toContain("/@vite/client");
  expect(html).toContain("/@react-refresh");
  expect(html).toContain("late-hook-style");
  return nonce;
}

describe("web dev CSP nonce transform", () => {
  it("keeps the production policy strict and leaves non-script/style directives unchanged", () => {
    expect(extractCspContent(indexHtml)).toBe(WEB_APP_PRODUCTION_CSP);
    expect(WEB_APP_PRODUCTION_CSP).not.toMatch(/nonce-|unsafe-inline/u);
    const transformed = withDevCspNonces(WEB_APP_PRODUCTION_CSP, testNonce);
    expect(transformed).toContain(`script-src 'self' 'nonce-${testNonce}'`);
    expect(transformed).toContain(`style-src 'self' 'nonce-${testNonce}'`);
    expect(withDevCspNonces(transformed, testNonce)).toBe(transformed);
    expect(withDevCspNonces("script-src-elem 'none'; style-src-attr 'none'", testNonce)).toBe(
      "script-src-elem 'none'; style-src-attr 'none'",
    );
  });

  it("finalizes placeholders and puts the policy before the React preamble", () => {
    const html = indexHtml.replace(
      "<head>",
      `<head><script nonce="${WEB_DEV_CSP_NONCE_PLACEHOLDER}">preamble()</script>`,
    );
    const rewritten = rewriteIndexHtmlCspForDev(html, testNonce);
    expect(extractCspContent(rewritten)).toBe(withDevCspNonces(WEB_APP_PRODUCTION_CSP, testNonce));
    expect(rewritten).toContain(`<script nonce="${testNonce}">preamble()</script>`);
    expect(rewritten.indexOf("Content-Security-Policy")).toBeLessThan(rewritten.indexOf("<script"));
    expect(rewritten.match(/http-equiv="Content-Security-Policy"/gu)).toHaveLength(1);
    expect(extractCspContent(indexHtml)).toBe(WEB_APP_PRODUCTION_CSP);
  });
  it.each([
    [
      "missing policy",
      indexHtml.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/u, ""),
    ],
    [
      "duplicate policy",
      indexHtml.replace(
        "<head>",
        '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'">',
      ),
    ],
    ["missing head", indexHtml.replace("<head>", "")],
    ["unclosed head", indexHtml.replace("</head>", "")],
    [
      "policy outside head",
      indexHtml.replace("<head>", "<head></head>").replace("</head>\n  <body>", "<body>"),
    ],
  ])("rejects %s instead of returning HTML without its policy", (_name, html) => {
    expect(() => rewriteIndexHtmlCspForDev(html, testNonce)).toThrow(
      "Development HTML requires exactly one CSP meta inside its head",
    );
  });
});

describe("real Vite development HTML pipeline", () => {
  let server: ViteDevServer;
  let origin: string;

  beforeAll(async () => {
    server = await createServer({
      root: webRoot,
      configFile,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, preTransformRequests: false },
      plugins: [
        {
          name: "test-late-resource-injection",
          transformIndexHtml: {
            order: "post",
            handler: () => [
              { tag: "style", attrs: { id: "late-hook-style" }, children: "body { color: red; }" },
              { tag: "script", attrs: { type: "module" }, children: "void 0;" },
              { tag: "link", attrs: { rel: "stylesheet", href: "/test.css" } },
            ],
          },
        },
      ],
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite did not bind a TCP port");
    origin = `http://127.0.0.1:${address.port}`;
  }, 20_000);

  afterAll(async () => {
    await server?.close();
  });

  it("uses fresh concurrent response nonces after Vite stamps React, CSS and post-hook tags", async () => {
    const nonces = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const route = ["/", "/channels/synthetic", "/?query=1", "/index.html?query=1"][i % 4];
        const response = await fetch(`${origin}${route}`, { headers: { Accept: "text/html" } });
        expect(response.status).toBe(200);
        return assertServedNonce(await response.text());
      }),
    );
    expect(new Set(nonces).size).toBe(8);
    expect(server.config.html.cspNonce).toBe(WEB_DEV_CSP_NONCE_PLACEHOLDER);
  });

  it("generates a fresh body and ETag on HTML revalidation", async () => {
    const first = await fetch(`${origin}/index.html`);
    const firstNonce = assertServedNonce(await first.text());
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const revalidated = await fetch(`${origin}/index.html`, {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(revalidated.status).toBe(200);
    expect(revalidated.headers.get("etag")).not.toBe(etag);
    expect(assertServedNonce(await revalidated.text())).not.toBe(firstNonce);
  });

  it("serves the actual plugin sandbox unchanged through its own middleware", async () => {
    const response = await fetch(`${origin}/plugin-sandbox.html`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(pluginProxyDocument());
  });

  it.each([
    ["build", "production"],
    ["build", "desktop"],
    ["serve", "desktop"],
  ] as const)("does not register nonce handling for %s / %s", async (command, mode) => {
    const config = await resolveConfig(
      { root: webRoot, configFile, mode, logLevel: "silent" },
      command,
    );
    expect(config.html?.cspNonce).toBeUndefined();
    expect(config.plugins.some((plugin) => plugin.name === "openbot-web-dev-csp-nonce")).toBe(
      false,
    );
  });
});
