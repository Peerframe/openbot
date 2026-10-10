/** Starts the app-owned Server with a parent-pipe lifetime and safe startup diagnostics. */
import { entryOptions } from "./config.js";
import { runEntry } from "./lifetime.js";
import { desktopStartupExitCode, reportFailure, startup } from "./logging.js";

try {
  if (process.argv.length !== 2 || process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Unsupported Desktop entry.");
  await runEntry(await startup("configuration", () => entryOptions(process.env)), true);
} catch (error) {
  reportFailure("desktop-startup", error);
  process.exitCode = desktopStartupExitCode(error);
}
