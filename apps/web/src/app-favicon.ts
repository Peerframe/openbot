/**
 * The browser-tab icon: the app icon's small drawing (docs/design/app-icon/app-icon-small.svg).
 * Added at start-up rather than in index.html, whose every <link> carries the development CSP
 * nonce; the strict CSP already allows `data:` images.
 */
const ICON =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"%3E%3Ctitle%3EOpenBot%3C/title%3E%3Crect x="16" y="16" width="992" height="992" rx="216" fill="%23F5F5F2" stroke="%23E3E3E6" stroke-width="32"/%3E%3Cg transform="translate%28120 120%29 scale%288.166667%29"%3E%3Cpath d="m39 30-4-10" fill="none" stroke="%2320251F" stroke-width="6" stroke-linecap="round"/%3E%3Ccircle cx="33" cy="16" r="5.6" fill="%2320251F"/%3E%3Cpath d="M12 61C12 41 27 26 47 26C68 26 83 41 83 61V71C83 83 69 89 48 89C26 89 12 83 12 71Z" fill="%2320251F"/%3E%3Cpath d="M12 69C29 76 66 76 83 69V72C83 83 69 89 48 89C26 89 12 83 12 72Z" fill="%2391CF4B"/%3E%3Cg fill="%23FAFBF7"%3E%3Crect x="28" y="43" width="12" height="21" rx="6"/%3E%3Crect x="54" y="43" width="12" height="21" rx="6"/%3E%3C/g%3E%3C/g%3E%3C/svg%3E';

export function installAppFavicon(doc: Document = document) {
  if (doc.querySelector('link[rel="icon"]')) return;
  const link = doc.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = ICON;
  doc.head.append(link);
}
