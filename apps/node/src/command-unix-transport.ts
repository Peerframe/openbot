import { createConnection, type Socket } from "node:net";
import { posix } from "node:path";
import { attachJsonTransport } from "./bounded-json-transport.mjs";
import {
  CommandRelayError,
  type CommandRelayInstallation,
  type CommandRelayTransport,
} from "./command-relay.js";

/** Trusted installation chooses the path; signed Host/Control messages retain authority. */
export function unixCommandInstallation(
  socketPath: string,
  selection: CommandRelayInstallation["selection"],
): CommandRelayInstallation {
  if (
    process.platform === "win32" ||
    typeof socketPath !== "string" ||
    !posix.isAbsolute(socketPath) ||
    posix.normalize(socketPath) !== socketPath ||
    socketPath.includes("\0") ||
    Buffer.byteLength(socketPath) > 103
  ) {
    throw new CommandRelayError("invalid_frame");
  }
  const selected = Object.freeze({ ...selection });
  return Object.freeze({
    selection: selected,
    openTransport: (options: Parameters<CommandRelayInstallation["openTransport"]>[0]) =>
      new Promise<CommandRelayTransport>((resolve, reject) => {
        if (options.signal.aborted) {
          reject(new CommandRelayError("aborted"));
          return;
        }
        let socket: Socket;
        let finished = false;
        const timer = setTimeout(() => fail("io_timeout"), 5_000);
        const abort = () => fail("aborted");
        const error = () => fail("io_failed");
        const cleanup = () => {
          clearTimeout(timer);
          options.signal.removeEventListener("abort", abort);
        };
        const fail = (code: "aborted" | "io_failed" | "io_timeout") => {
          if (finished) return;
          finished = true;
          cleanup();
          socket?.destroy();
          reject(new CommandRelayError(code));
        };
        options.signal.addEventListener("abort", abort, { once: true });
        try {
          socket = createConnection({ path: socketPath });
          // Retain the listener until destruction completes, including asynchronous errors.
          socket.on("error", error);
          socket.once("close", () => {
            fail("io_failed");
            socket.removeListener("error", error);
          });
          socket.once("connect", () => {
            if (finished || options.signal.aborted) {
              fail("aborted");
              socket.destroy();
              return;
            }
            try {
              const transport = attachJsonTransport(socket, {
                signal: options.signal,
                onMessage: options.onMessage,
                onClose: options.onClose,
              });
              finished = true;
              cleanup();
              resolve(transport);
            } catch {
              fail("io_failed");
            }
          });
        } catch {
          fail("io_failed");
        }
      }),
  });
}
