/**
 * Dev-only CSP nonce helpers for `vite` serve.
 *
 * Vite 8.2.2 `html.cspNonce` stamps script/style/link tags and injects
 * `<meta property="csp-nonce" nonce="...">` so HMR/CSS-in-JS can read the
 * nonce. Production and Desktop builds keep the strict meta CSP in
 * `index.html` (no `'unsafe-inline'`, no fixed nonce).
 *
 * A fixed nonce is acceptable only for the local Vite dev server; real
 * deployments must replace a placeholder per request.
 */

/** Fixed nonce for local `vite` serve only — not for production HTML. */
export const WEB_DEV_CSP_NONCE = "openbot-vite-dev-csp-nonce";

/** Production / Desktop meta CSP from `apps/web/index.html` (strict, no nonce). */
export const WEB_APP_PRODUCTION_CSP =
  "base-uri 'none'; default-src 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-src 'self'; media-src 'self' blob:";

/**
 * Append `'nonce-<value>'` to `script-src` and `style-src` without adding
 * `'unsafe-inline'`. Idempotent when the nonce token is already present.
 */
export function withDevCspNonces(csp: string, nonce: string = WEB_DEV_CSP_NONCE): string {
  const token = `'nonce-${nonce}'`;
  return csp.replace(
    /\b(script-src|style-src)((?:(?!;).)*)/gu,
    (match, directive: string, rest: string) => {
      if (rest.includes(token)) return match;
      return `${directive}${rest} ${token}`;
    },
  );
}

/** Rewrite the document CSP meta `content` for Vite serve HTML only. */
export function rewriteIndexHtmlCspForDev(
  html: string,
  nonce: string = WEB_DEV_CSP_NONCE,
): string {
  return html.replace(/<meta\b[^>]*>/giu, (tag) => {
    if (!/\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\1/iu.test(tag)) return tag;
    return tag.replace(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/iu, (_full, quote: string, content: string) => {
      return `content=${quote}${withDevCspNonces(content, nonce)}${quote}`;
    });
  });
}
