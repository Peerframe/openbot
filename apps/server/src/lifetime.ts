/** Binds Server shutdown to its explicit Desktop parent or operating-system lifetime. */
import { reportFailure } from "./logging.js";
import { createEntry } from "./app.js";
import type { EntryOptions } from "./config.js";

export async function runEntry(options: EntryOptions, parentPipe = false): Promise<void> {
  const app = await createEntry(options);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 8000);
    void app
      .close()
      .then(() => {
        clearTimeout(deadline);
      })
      .catch((error) => {
        reportFailure("shutdown", error);
        process.exitCode = 1;
      });
    if (parentPipe) process.stdin.destroy();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (parentPipe) {
    // Only the inherited fixed Desktop pipe owns lifetime. Neither network nor renderer
    // input can name an action; any input or parent EOF means stop, without reconnect.
    process.stdin.once("data", stop);
    process.stdin.once("end", stop);
    process.stdin.once("error", stop);
    process.stdin.resume();
  }
  await app.listen({ host: options.host, port: options.port });
  if (closing) await app.close();
}
