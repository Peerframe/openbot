import { entryOptions } from "./config.js";
import { runEntry } from "./lifetime.js";

try {
  if (process.argv.length !== 2 || process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Unsupported Desktop entry.");
  await runEntry(entryOptions(process.env), true);
} catch {
  console.error("TS Desktop entry could not start.");
  process.exitCode = 1;
}
