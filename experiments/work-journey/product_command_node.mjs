// Explicit fixture credentials and loopback transport; no ambient Node credential store.
import { OpenBotNodeClient } from "../../apps/node/src/client.ts";
import { unixCommandInstallation } from "../../apps/node/src/command-unix-transport.ts";

async function main() {
  let input = "";
  for await (const part of process.stdin) {
    input += part.toString("utf8");
    if (Buffer.byteLength(input) > 8192) throw new Error("Oversized fixture input");
  }
  const config = JSON.parse(input);
  if (config.version !== 1 || config.nodeId !== config.selection.nodeId)
    throw new Error("Explicit fixture identity required");
  const address = new URL(config.serverUrl);
  if (
    address.protocol !== "ws:" ||
    address.hostname !== "127.0.0.1" ||
    address.pathname !== "/ws/nodes"
  )
    throw new Error("Owned loopback Node fixture required");
  const env = {
    OPENBOT_NODE_ID: config.nodeId,
    OPENBOT_NODE_SERVER_URL: config.serverUrl,
    OPENBOT_NODE_ENROLLMENT_TOKEN: config.enrollmentToken,
    OPENBOT_NODE_MAX_CONCURRENT_RUNS: 1,
    OPENBOT_LOG_LEVEL: "error",
  };
  let credential;
  const logger = {
    info() {},
    warn(code) {
      if (code === "node.command_relay_closed" || code === "node.connection_failed") void close();
    },
    error() {
      process.stderr.write("Node fixture rejected an operation\n");
      void close();
    },
  };
  const client = new OpenBotNodeClient(
    env,
    [],
    {
      load: async () => credential,
      save: async (value) => {
        credential = value;
      },
    },
    logger,
    unixCommandInstallation(config.socketPath, config.selection),
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearTimeout(deadline);
    await client.stop();
  };
  const deadline = setTimeout(() => {
    void close();
  }, 150_000);
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  await client.start();
}
main().catch(() => {
  process.stderr.write("Node fixture failed\n");
  process.exitCode = 1;
});
