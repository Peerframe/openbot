// Real Node + Docker provider, with an explicitly synthetic loopback computer.
import { once } from "node:events";
import { createServer } from "node:http";
import { nodeEnvSchema } from "@openbot/config";
import { createSilentLogger } from "@openbot/logging";
import { OpenBotNodeClient } from "../../../node/src/client.ts";
import { configuredProviders } from "../../../node/src/providers.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
let captures = 0;
const computer = createServer(async (req, res) => {
  if (req.url !== "/screenshot" || req.headers["x-openbot-computer-token"] !== "synthetic-computer-only") {
    res.writeHead(403).end();
    return;
  }
  if (req.headers["x-openbot-bot-id"] !== config.botId) {
    res.writeHead(403).end();
    return;
  }
  captures++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ base64: config.png, width: 1, height: 1, capturedAt: new Date().toISOString(), url: "about:blank" }));
  process.stdout.write(JSON.stringify({ captures }) + "\n");
});
computer.listen(0, "127.0.0.1");
await once(computer, "listening");
const env = nodeEnvSchema.parse({
  OPENBOT_NODE_ID: config.nodeId,
  OPENBOT_NODE_SERVER_URL: config.serverUrl,
  OPENBOT_DOCKER_COMPUTER_URL: `http://127.0.0.1:${computer.address().port}`,
  OPENBOT_DOCKER_COMPUTER_TOKEN: "synthetic-computer-only",
  OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS: "true",
  OPENBOT_DOCKER_BROWSER_SESSIONS: "true",
});
const client = new OpenBotNodeClient(env, configuredProviders(env), {
  load: async () => ({ format: "openbot.node-identity/v1", nodeId: config.nodeId, credential: config.credential, enrolledAt: new Date().toISOString() }),
  save: async () => {},
}, createSilentLogger());
process.once("SIGTERM", async () => {
  await client.stop();
  computer.closeAllConnections();
  computer.close();
});
await client.start();
process.stdout.write('{"started":true}\n');
