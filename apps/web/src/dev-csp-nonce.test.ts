import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  rewriteIndexHtmlCspForDev,
  WEB_APP_PRODUCTION_CSP,
  WEB_DEV_CSP_NONCE,
  withDevCspNonces,
} from "./dev-csp-nonce";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = readFileSync(resolve(webRoot, "index.html"), "utf8");

function extractCspContent(html: string): string {
  const match = html.match(
    /<meta\b[^>]*\bhttp-equiv=(["'])Content-Security-Policy\1[^>]*\bcontent=(["'])([\s\S]*?)\2/iu,
  );
  if (!match?.[3]) throw new Error("CSP meta content missing");
  return match[3];
}

describe("web dev CSP nonce transform", () => {
  it("keeps production index.html CSP strict (no nonce, no unsafe-inline)", () => {
    const productionCsp = extractCspContent(indexHtml);
    expect(productionCsp).toBe(WEB_APP_PRODUCTION_CSP);
    expect(productionCsp).toContain("script-src 'self'");
    expect(productionCsp).toContain("style-src 'self'");
    expect(productionCsp).not.toMatch(/nonce-/u);
    expect(productionCsp).not.toContain("unsafe-inline");
  });

  it("adds the same nonce to script-src and style-src without unsafe-inline", () => {
    const transformed = withDevCspNonces(WEB_APP_PRODUCTION_CSP);
    expect(transformed).toContain(`script-src 'self' 'nonce-${WEB_DEV_CSP_NONCE}'`);
    expect(transformed).toContain(`style-src 'self' 'nonce-${WEB_DEV_CSP_NONCE}'`);
    expect(transformed).not.toContain("unsafe-inline");
    expect(withDevCspNonces(transformed)).toBe(transformed);
  });

  it("rewrites the index.html CSP meta for serve while leaving other markup intact", () => {
    const rewritten = rewriteIndexHtmlCspForDev(indexHtml);
    const csp = extractCspContent(rewritten);
    expect(csp).toContain(`'nonce-${WEB_DEV_CSP_NONCE}'`);
    expect(csp).toMatch(/script-src[^;]*'nonce-openbot-vite-dev-csp-nonce'/u);
    expect(csp).toMatch(/style-src[^;]*'nonce-openbot-vite-dev-csp-nonce'/u);
    expect(csp).not.toContain("unsafe-inline");
    expect(rewritten).toContain('src="/src/main.tsx"');
    expect(rewritten).not.toBe(indexHtml);
    expect(extractCspContent(indexHtml)).toBe(WEB_APP_PRODUCTION_CSP);
  });
});
