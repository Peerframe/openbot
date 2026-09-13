/**
 * Vite 8.2.2 owns nonce stamping and CSS/React HMR. Its placeholder is replaced
 * only after the complete dev HTML transform; production/Desktop never use it.
 */
export const WEB_DEV_CSP_NONCE_PLACEHOLDER = "__OPENBOT_WEB_DEV_CSP_NONCE__";

/** Production / Desktop meta CSP from `apps/web/index.html` (strict, no nonce). */
export const WEB_APP_PRODUCTION_CSP =
  "base-uri 'none'; default-src 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-src 'self'; media-src 'self' blob:";

/** Add the response nonce only to the existing script and style directives. */
export function withDevCspNonces(csp: string, nonce: string): string {
  const token = `'nonce-${nonce}'`;
  return csp.replace(
    /(^|;)(\s*)(script-src|style-src)(?=\s|;|$)([^;]*)/gu,
    (match, separator: string, whitespace: string, directive: string, rest: string) => {
      if (rest.includes(token)) return match;
      return `${separator}${whitespace}${directive}${rest} ${token}`;
    },
  );
}

/** Finalize the main development document after Vite has stamped its tags. */
export function rewriteIndexHtmlCspForDev(html: string, nonce: string): string {
  const head = [...html.matchAll(/<head\b[^>]*>/giu)];
  const headEnd = [...html.matchAll(/<\/head\s*>/giu)];
  const policies = [...html.matchAll(/<meta\b[^>]*>/giu)].filter((match) =>
    /\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\1/iu.test(match[0]),
  );
  const policy = policies[0];
  if (
    head.length !== 1 ||
    headEnd.length !== 1 ||
    policies.length !== 1 ||
    !policy ||
    policy.index < (head[0]?.index ?? Infinity) ||
    policy.index > (headEnd[0]?.index ?? -1) ||
    !/\bcontent\s*=\s*(["'])([\s\S]+?)\1/iu.test(policy[0])
  ) {
    throw new Error("Development HTML requires exactly one CSP meta inside its head");
  }
  const policyTag = policy[0].replace(
    /\bcontent\s*=\s*(["'])([\s\S]*?)\1/iu,
    (_full, quote: string, content: string) =>
      `content=${quote}${withDevCspNonces(content, nonce)}${quote}`,
  );
  const rewritten = html.slice(0, policy.index) + html.slice(policy.index + policy[0].length);
  // The meta policy must precede Vite's head-prepended React preamble and client.
  return rewritten
    .replace(/<head\b[^>]*>/iu, (headTag) => `${headTag}\n${policyTag}`)
    .replaceAll(WEB_DEV_CSP_NONCE_PLACEHOLDER, nonce);
}
