import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { nodeEnvSchema } from "../../packages/config/src/index.ts";
import { createSilentLogger } from "../../packages/logging/src/index.ts";
import { OpenBotNodeClient } from "../../apps/node/src/client.ts";
import { configuredProviders } from "../../apps/node/src/providers.ts";

export async function startProbeClient(c) {
  const env = nodeEnvSchema.parse({
    OPENBOT_NODE_ID: c.nodeId,
    OPENBOT_NODE_NAME: "Synthetic Browser Host",
    OPENBOT_NODE_SERVER_URL: c.serverUrl,
    OPENBOT_DOCKER_COMPUTER_URL: c.computerUrl,
    OPENBOT_DOCKER_COMPUTER_TOKEN: c.token,
    OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS: "true",
    OPENBOT_DOCKER_INPUT_ORIGINS: c.targetUrl,
    OPENBOT_DOCKER_BROWSER_SESSIONS: "true",
    OPENBOT_DOCKER_BROWSER_TASKS: "true",
  });
  const providers = configuredProviders(env);
  let calls = {};
  try {
    calls = JSON.parse(await readFile(c.directory + "/browser-counts.json", "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const provider of providers) {
    if (provider.browserTask) {
      const run = provider.browserTask;
      provider.browserTask = async (...args) => {
        const kind = args[0].action.operation.kind;
        calls[kind] = (calls[kind] || 0) + 1;
        await writeFile(c.directory + "/browser-counts.json", JSON.stringify(calls));
        try {
          return await run(...args);
        } catch (error) {
          await writeFile(
            c.directory + "/provider-error.json",
            JSON.stringify({ name: error.name, message: error.message }),
          );
          throw error;
        }
      };
    }
  }
  const makeClient = (credential) =>
    new OpenBotNodeClient(
      env,
      providers,
      {
        load: async () => ({
          format: "openbot.node-identity/v1",
          nodeId: c.nodeId,
          credential,
          enrolledAt: new Date().toISOString(),
        }),
        save: async () => {},
      },
      createSilentLogger(),
    );
  const client = makeClient(c.credential);
  await client.start();
  return client;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const client = await startProbeClient(JSON.parse(input));
  process.once("SIGTERM", () => void client.stop());
  process.once("SIGINT", () => void client.stop());
  process.stdout.write('{"started":true}\n');
}
