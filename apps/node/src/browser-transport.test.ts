import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { nodeEnvSchema } from "@openbot/config";
import { createSilentLogger } from "@openbot/logging";
import {
  type BrowserAction,
  type BrowserResult,
  nodeMessageSchema,
  protocolVersion,
} from "@openbot/protocol";
import { expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { createDockerProvider } from "../../../providers/docker/src/index.js";
import { OpenBotNodeClient } from "./client.js";

it("relays real authenticated WS commands through the opt-in provider to bounded synthetic HTTP", async () => {
  const requests: string[] = [];
  const inputs: string[] = [];
  let holder = false;
  let location = "about:blank";
  const png = Buffer.alloc(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  const server = createServer(async (req, res) => {
    if (req.url === "/synthetic-form") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<form><input name="synthetic"><button>Submit</button></form>');
      return;
    }
    expect(req.headers["x-openbot-computer-token"]).toBe("synthetic-computer-key");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push(req.url ?? "");
    if (req.url === "/control/take") holder = true;
    if (req.url === "/control/release") holder = false;
    if (req.url === "/navigate") location = body.url;
    if (req.url === "/human/type") {
      expect(holder).toBe(true);
      inputs.push(body.text);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url === "/screenshot"
          ? {
              base64: png.toString("base64"),
              width: 1,
              height: 1,
              capturedAt: new Date().toISOString(),
              url: location,
            }
          : {},
      ),
    );
  });
  const gateway = new WebSocketServer({ server, path: "/nodes" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No synthetic listener");
  const base = `http://127.0.0.1:${address.port}`;
  const provider = createDockerProvider({
    computerUrl: base,
    computerToken: "synthetic-computer-key",
    enableBrowserSessions: true,
    allowPrivateHosts: true,
  });
  const client = new OpenBotNodeClient(
    nodeEnvSchema.parse({
      OPENBOT_NODE_ID: "browser-test",
      OPENBOT_NODE_SERVER_URL: `ws://127.0.0.1:${address.port}/nodes`,
    }),
    [provider],
    {
      load: async () => ({
        format: "openbot.node-identity/v1",
        nodeId: "browser-test",
        credential: `obn_${"a".repeat(43)}`,
        enrolledAt: new Date().toISOString(),
      }),
      save: async () => {},
    },
    createSilentLogger(),
  );
  const responses = new Map<string, (value: BrowserResult) => void>();
  let socket: WebSocket;
  let ready: () => void = () => {};
  const hello = new Promise<void>((resolve) => {
    ready = resolve;
  });
  gateway.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (raw) => {
      const value = nodeMessageSchema.parse(JSON.parse(raw.toString()));
      if (value.type === "node.hello") {
        expect(value.capabilityManifest.some((cap) => cap.id === "browser.session")).toBe(true);
        ready();
      } else if (value.type === "browser.result") responses.get(value.requestId)?.(value);
    });
  });
  const botId = randomUUID(),
    sessionId = randomUUID();
  const frame = (action: BrowserAction) => ({
    type: "browser.command",
    protocolVersion,
    nodeId: "browser-test",
    requestId: randomUUID(),
    sessionId,
    botId,
    action,
    expiresAt: new Date(Date.now() + 25000).toISOString(),
    controlExpiresAt: new Date(Date.now() + 30000).toISOString(),
  });
  const send = (action: BrowserAction) => {
    const value = frame(action);
    const result = new Promise<BrowserResult>((resolve) => responses.set(value.requestId, resolve));
    socket.send(JSON.stringify(value));
    return result;
  };
  try {
    await client.start();
    await hello;
    socket!.send(JSON.stringify(frame({ kind: "take" })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([]);
    socket!.send(
      JSON.stringify({
        type: "server.ack",
        protocolVersion,
        accepted: true,
        receivedAt: new Date().toISOString(),
      }),
    );
    expect((await send({ kind: "take" })).ok).toBe(true);
    expect((await send({ kind: "navigate", url: `${base}/synthetic-form` })).ok).toBe(true);
    expect((await send({ kind: "type", text: "合成输入 🌏" })).ok).toBe(true);
    expect(inputs).toEqual(["合成输入 🌏"]);
    expect((await send({ kind: "release" })).ok).toBe(true);
    expect(holder).toBe(false);
    expect((await send({ kind: "click", x: 0, y: 0 })).ok).toBe(false);
    expect(requests).not.toContain("/human/click");
  } finally {
    await client.stop();
    for (const item of gateway.clients) item.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("keeps default provider startup free of the human session capability", () => {
  const provider = createDockerProvider({
    computerUrl: "http://127.0.0.1:1",
    computerToken: "synthetic",
  });
  expect(provider.browser).toBeUndefined();
  expect(provider.capabilityManifest.some((cap) => cap.id === "browser.session")).toBe(false);
});
