/** Starts the app-owned Server with a parent-pipe lifetime and safe startup diagnostics. */
import { entryOptions } from "./config.js";
import { reportFailure, startup } from "./logging.js";
import { runEntry } from "./lifetime.js";

try {
  if (process.argv.length !== 2 || process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Unsupported Desktop entry.");
  await runEntry(await startup("configuration", () => entryOptions(process.env)), true);
} catch (error) {
  reportFailure("desktop-startup", error);
  process.exitCode = 1;
}
