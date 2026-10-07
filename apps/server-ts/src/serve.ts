import { entryOptions } from "./config.js";
import { runEntry } from "./lifetime.js";

try {
  await runEntry(entryOptions(process.env));
} catch {
  console.error(
    "TS control-plane entry could not start; check its explicit private/public configuration.",
  );
  process.exitCode = 1;
}
