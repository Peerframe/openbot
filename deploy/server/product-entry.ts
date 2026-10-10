/** Starts the single product Server only after validated storage, SQL migration and legacy drain. */
import { pathToFileURL } from "node:url";
import { runEntry } from "../../apps/server/dist/lifetime.js";
import { reportFailure, startup } from "../../apps/server/dist/logging.js";
import { prepareProduct } from "./prepare-product.ts";
export async function startProduct(environment: NodeJS.ProcessEnv) {
  const options = await startup("deployment-preflight", () => prepareProduct(environment));
  await runEntry(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try { await startProduct(process.env); }
  catch (error) { reportFailure("deployment-startup", error); process.exitCode = 1; }
}
