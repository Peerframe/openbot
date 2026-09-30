import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OpenBotNodeClient } from "../../apps/node/src/client.ts";
import { configuredProviders } from "../../apps/node/src/providers.ts";
import { nodeEnvSchema } from "../../packages/config/src/index.ts";
import { createSilentLogger } from "../../packages/logging/src/index.ts";
import {
  jsonRecord,
  type ProbeClientConfig,
  parseProbeClientConfig,
  readOptionalJson,
  readStdinJson,
} from "./probe-inputs.ts";

type BrowserCounts = Record<string, number>;

/** Python compares these per-operation counts before and after offline replay. */
function browserCounts(value: unknown): BrowserCounts {
  const counts: BrowserCounts = {};
  if (value === undefined) return counts;
  for (const [kind, count] of Object.entries(jsonRecord(value, "browser counts"))) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new Error("Invalid fixture browser counts");
    counts[kind] = count;
  }
  return counts;
}

function providerError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
}

export async function startProbeClient(c: ProbeClientConfig): Promise<OpenBotNodeClient> {
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
  const countsPath = `${c.directory}/browser-counts.json`;
  const calls = browserCounts(await readOptionalJson(countsPath));
  for (const provider of providers) {
    const run = provider.browserTask;
    if (run === undefined) continue;
    provider.browserTask = async (command, signal) => {
      if (command.action.kind !== "agent")
        throw new TypeError("Browser task fixture requires an agent operation");
      const kind = command.action.operation.kind;
      calls[kind] = (calls[kind] ?? 0) + 1;
      await writeFile(countsPath, JSON.stringify(calls));
      try {
        return await run(command, signal);
      } catch (error) {
        await writeFile(`${c.directory}/provider-error.json`, JSON.stringify(providerError(error)));
        throw error;
      }
    };
  }
  const client = new OpenBotNodeClient(
    env,
    providers,
    {
      load: async () => ({
        format: "openbot.node-identity/v1",
        nodeId: c.nodeId,
        credential: c.credential,
        enrolledAt: new Date().toISOString(),
      }),
      save: async () => {},
    },
    createSilentLogger(),
  );
  await client.start();
  return client;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const client = await startProbeClient(parseProbeClientConfig(await readStdinJson(process.stdin)));
  process.once("SIGTERM", () => void client.stop());
  process.once("SIGINT", () => void client.stop());
  process.stdout.write('{"started":true}\n');
}
