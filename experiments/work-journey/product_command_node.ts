// Explicit fixture credentials and loopback transport; no ambient Node credential store.
import { OpenBotNodeClient } from "../../apps/node/src/client.ts";
import { unixCommandInstallation } from "../../apps/node/src/command-unix-transport.ts";
import type { NodeCredentialStore } from "../../apps/node/src/credential-store.ts";
import { nodeEnvSchema } from "../../packages/config/src/index.ts";
import type { OpenBotLogger } from "../../packages/logging/src/index.ts";
import { parseCommandNodeInput, readStdinJson } from "./probe-inputs.ts";

const INPUT_LIMIT_BYTES = 8192;
const FIXTURE_DEADLINE_MS = 150_000;

function assertOwnedLoopback(serverUrl: string): void {
  const address = new URL(serverUrl);
  if (
    address.protocol !== "ws:" ||
    address.hostname !== "127.0.0.1" ||
    address.pathname !== "/ws/nodes"
  )
    throw new Error("Owned loopback Node fixture required");
}

async function main(): Promise<void> {
  const config = parseCommandNodeInput(await readStdinJson(process.stdin, INPUT_LIMIT_BYTES));
  assertOwnedLoopback(config.serverUrl);
  // The production schema supplies defaults and validates the explicit fixture identity.
  const env = nodeEnvSchema.parse({
    OPENBOT_NODE_ID: config.nodeId,
    OPENBOT_NODE_SERVER_URL: config.serverUrl,
    OPENBOT_NODE_ENROLLMENT_TOKEN: config.enrollmentToken,
    OPENBOT_NODE_MAX_CONCURRENT_RUNS: 1,
    OPENBOT_LOG_LEVEL: "error",
  });
  let credential: Awaited<ReturnType<NodeCredentialStore["load"]>> = undefined;
  const logger: OpenBotLogger = {
    debug() {},
    info() {},
    warn(event) {
      if (event === "node.command_relay_closed" || event === "node.connection_failed") void close();
    },
    error() {
      process.stderr.write("Node fixture rejected an operation\n");
      void close();
    },
    child: () => logger,
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
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearTimeout(deadline);
    await client.stop();
  };
  const deadline = setTimeout(() => {
    void close();
  }, FIXTURE_DEADLINE_MS);
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
