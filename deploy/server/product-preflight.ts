/** Verifies the fixed runtime closure without opening a database or starting execution. */
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const PRODUCT_NODE_VERSION = "24.21.0";
const RUNTIME_MODULES = [
  "@temporalio/worker",
  "@fastify/static",
  "koffi",
  "officeparser",
  "pdfjs-dist",
  "tesseract.js",
  "@tesseract.js-data/eng",
  "@tesseract.js-data/chi_sim",
] as const;
const MIGRATION_COUNT = 58;
if (process.versions.node !== PRODUCT_NODE_VERSION)
  throw new Error("Product Node version mismatch.");
const require = createRequire(new URL("../../package.json", import.meta.url));
for (const name of RUNTIME_MODULES) require.resolve(name);
const journal: unknown = JSON.parse(
  await readFile(
    new URL("../../packages/db/migrations/meta/_journal.json", import.meta.url),
    "utf8",
  ),
);
if (
  typeof journal !== "object" ||
  journal === null ||
  !("entries" in journal) ||
  !Array.isArray(journal.entries) ||
  journal.entries.length !== MIGRATION_COUNT
)
  throw new Error("Product migration snapshot changed; requalify it.");
await access(new URL("../../apps/web/dist/index.html", import.meta.url));
await import("../../packages/db/dist/index.js");

await import("../../apps/server/dist/app.js");
await access(new URL("../../apps/server/dist/parser-worker.js", import.meta.url));
