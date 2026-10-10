/** Validates deployment boundaries, applies canonical SQL and proves old execution is drained. */
import { lstat, realpath } from "node:fs/promises";
import { entryOptions } from "../../apps/server/dist/config.js";
import { loadWorkInstallation } from "../../apps/server/dist/work-installation.js";
import { createDatabase } from "../../packages/db/dist/index.js";
import { verifyLegacyWorkPreflight } from "./legacy-work-preflight.ts";

export async function prepareProduct(environment: NodeJS.ProcessEnv) {
  const options = entryOptions(environment);
  const product = options.product, temporal = environment.OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH;
  if (!product?.files || !product.work || typeof product.work.tokenLimit !== "number" || !temporal)
    throw new Error("Complete product configuration is required.");
  if (environment.OPENBOT_DATABASE_URL && product.databaseUrl !== environment.OPENBOT_DATABASE_URL)
    throw new Error("Migration and Server databases must match.");
  for (const path of new Set([product.files.objectRoot, product.files.artifactRoot, product.work.fileRoot])) {
    if (!path) throw new Error("Product storage must be explicit.");
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path ||
      (process.platform !== "win32" && (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700)))
      throw new Error("Product storage must be a private owned directory.");
  }
  const installed = loadWorkInstallation({ temporal,
    fileRoot: product.work.fileRoot, tokenLimit: product.work.tokenLimit });
  const database = createDatabase(product.databaseUrl);
  try { await database.migrate(); } finally { await database.close(); }
  await verifyLegacyWorkPreflight(product.databaseUrl, installed);
  return options;
}
