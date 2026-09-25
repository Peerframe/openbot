// No database/provider access: resolve the exact retained runtime, then import its DB API only.
import { createRequire } from "node:module";
import { readFile, access } from "node:fs/promises";
const require = createRequire(new URL("../../package.json", import.meta.url));
if (process.versions.node !== "24.21.0") throw new Error("Product Node version mismatch.");
for (const name of [
  "officeparser",
  "pdfjs-dist",
  "tesseract.js",
  "@tesseract.js-data/eng",
  "@tesseract.js-data/chi_sim",
])
  require.resolve(name);
const journal = JSON.parse(
  await readFile(new URL("../../packages/db/migrations/meta/_journal.json", import.meta.url)),
);
if (journal.entries.length !== 43)
  throw new Error("Product migration snapshot changed; requalify it.");
await access(new URL("../../apps/web/dist/index.html", import.meta.url));
await import("../../packages/db/dist/index.js");
