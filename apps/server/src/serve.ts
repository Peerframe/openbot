/** Starts the configured Server and reports a safe diagnostic when startup is refused. */
import { entryOptions } from "./config.js";
import { runEntry } from "./lifetime.js";
import { reportFailure, startup } from "./logging.js";

try {
  await runEntry(await startup("configuration", () => entryOptions(process.env)));
} catch (error) {
  reportFailure("startup", error);
  process.exitCode = 1;
}
