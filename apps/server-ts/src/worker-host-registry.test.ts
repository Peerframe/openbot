import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  commandProtocolVersion,
  protocolVersion,
  type BrowserCommand,
  type ServerMessage,
  type CommandServerFrame,
  type CommandPreparationBinding,
} from "@openbot/protocol";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { WorkerHostRegistry } from "./worker-host-registry.js";

import type { CommandNotifications, CommandPending } from "./worker-command-channel.js";

const hello = () => ({
  type: "node.hello",
  protocolVersion,
  nodeId: "synthetic-worker",
  name: "Fixture",
  platform: "linux",
  capabilities: ["browser"],
  maxConcurrentRuns: 2,
  capabilityManifest: [{ id: "browser.session", version: 1, providerId: "docker" }],
  credential: "obn_" + "q".repeat(43),
  sentAt: new Date().toISOString(),
});
async function fixture(authenticate = async () => "a".repeat(64), commands?: CommandNotifications) {
  const events = vi.fn(async () => {}),
    run = vi.fn(),
    unavailable = vi.fn();
  const registry = new WorkerHostRegistry(
    {
      authenticate,
      connectionEvent: events,
      fence: {
        run: async (_key, signal, operation) => {
          signal.throwIfAborted();
          return operation(signal, 0);
        },
      },
    },
    { run, unavailable },
    commands,
  );
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port required");
  const origin = `http://127.0.0.1:${address.port}`;
  registry.attach(server, origin);
  const clients = new Set<WebSocket>();
  const peer = async () => {
    const socket = new WebSocket(origin.replace("http:", "ws:") + "/ws/nodes");
    clients.add(socket);
    const frames: (ServerMessage | CommandServerFrame)[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    socket.on("error", () => {});
    await once(socket, "open");
    const frame = async (
      accept: (message: ServerMessage | CommandServerFrame) => boolean = () => true,
    ) => {
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const index = frames.findIndex(accept);
        if (index >= 0) return frames.splice(index, 1)[0]!;
        await delay(5);
      }
      throw new Error("Expected Worker fixture frame");
    };
    const enroll = async (commandChannel = false) => {
      socket.send(
        JSON.stringify({
          ...hello(),
          ...(commandChannel
            ? { commandChannel: { protocolVersion: commandProtocolVersion } }
            : {}),
        }),
      );
      const received = await frame();
      expect(received).toMatchObject({ type: "server.ack", accepted: true });
      return received;
    };
    return { socket, frame, enroll, send: (value: unknown) => socket.send(JSON.stringify(value)) };
  };
  return {
    registry,
    peer,
    events,
    run,
    unavailable,
    async close() {
      for (const client of clients) client.terminate();
      await registry.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function command(): BrowserCommand {
  return {
    type: "browser.command",
    protocolVersion,
    nodeId: hello().nodeId,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    botId: randomUUID(),
    expiresAt: new Date(Date.now() + 3000).toISOString(),
    action: { kind: "observe" },
  };
}
const guard = async (_frame: BrowserCommand, _signal: AbortSignal, send: () => Promise<void>) =>
  send();

it("authenticates once, keeps credentials private and refuses heartbeat self-assignment", async () => {
  const f = await fixture();
  try {
    const p = await f.peer();
    await p.enroll();
    const runId = randomUUID();
    p.send({
      type: "node.heartbeat",
      protocolVersion,
      nodeId: hello().nodeId,
      activeRunIds: [runId],
      sentAt: new Date().toISOString(),
    });
    expect(await p.frame()).toMatchObject({ accepted: true });
    expect(f.registry.list()[0]!.activeRunIds).toEqual([]);
    expect(JSON.stringify(f.registry.list())).not.toContain("credential");
    p.send({
      type: "run.start_request",
      protocolVersion,
      nodeId: hello().nodeId,
      runId,
      requestedAt: new Date().toISOString(),
    });
    expect(await p.frame()).toMatchObject({ accepted: false });
    expect(f.run).not.toHaveBeenCalled();
    p.send(hello());
    expect(await p.frame()).toMatchObject({ accepted: false });
    await vi.waitFor(() => expect(f.registry.list()).toEqual([]));
  } finally {
    await f.close();
  }
});

it("discards pre-auth frames even when an in-flight credential lookup later succeeds", async () => {
  let resume!: (value: string) => void;
  const auth = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resume = resolve;
      }),
  );
  const f = await fixture(auth);
  try {
    const p = await f.peer();
    p.send(hello());
    await vi.waitFor(() => expect(auth).toHaveBeenCalledOnce());
    const closed = once(p.socket, "close");
    p.send({
      type: "node.heartbeat",
      protocolVersion,
      nodeId: hello().nodeId,
      activeRunIds: [],
      sentAt: new Date().toISOString(),
    });
    await closed;
    resume("a".repeat(64));
    await delay(10);
    expect(f.registry.list()).toEqual([]);
    expect(f.events).not.toHaveBeenCalled();
  } finally {
    resume?.("a".repeat(64));
    await f.close();
  }
});

it("correlates actual browser replies and invalidates the original connection after reconnect", async () => {
  const f = await fixture();
  try {
    const p = await f.peer();
    await p.enroll();
    const binding = f.registry.browserBinding(hello().nodeId),
      frame = command();
    const result = f.registry.browserCommand(frame, binding, guard, AbortSignal.timeout(3000));
    expect(await p.frame((value) => value.type === "browser.command")).toEqual(frame);
    p.send({
      type: "browser.result",
      protocolVersion,
      nodeId: frame.nodeId,
      requestId: frame.requestId,
      sessionId: frame.sessionId,
      ok: false,
      error: "unavailable",
    });
    expect(await result).toMatchObject({ requestId: frame.requestId, ok: false });
    const next = command();
    const pending = f.registry.browserCommand(next, binding, guard, AbortSignal.timeout(3000));
    const rejected = expect(pending).rejects.toThrow("worker_runtime_unavailable");
    await p.frame((value) => value.type === "browser.command");
    const replacement = await f.peer();
    await replacement.enroll();
    await rejected;
    expect(f.registry.browserBinding(hello().nodeId).connectionId).not.toBe(binding.connectionId);
    await expect(
      f.registry.browserCommand(command(), binding, guard, AbortSignal.timeout(3000)),
    ).rejects.toThrow();
    expect(f.registry.list()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("does not send without a successful authority guard, or after the command expires", async () => {
  const f = await fixture();
  try {
    const p = await f.peer();
    await p.enroll();
    const binding = f.registry.browserBinding(hello().nodeId);
    await expect(
      f.registry.browserCommand(
        command(),
        binding,
        async () => {
          throw new Error("Owner revoked");
        },
        AbortSignal.timeout(3000),
      ),
    ).rejects.toThrow("Owner revoked");
    const expired = { ...command(), expiresAt: new Date(Date.now() - 1).toISOString() };
    await expect(
      f.registry.browserCommand(expired, binding, guard, AbortSignal.timeout(3000)),
    ).rejects.toThrow();
    expect(f.registry.list()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

const preparation = (connectionId: string): CommandPreparationBinding => ({
  taskId: randomUUID(),
  runId: randomUUID(),
  actionId: randomUUID(),
  preparationId: randomUUID(),
  connectionId,
  originalEpoch: 1,
  authorityGeneration: 1,
  profileDigest: "b".repeat(64),
  intentDigest: "c".repeat(64),
  operationFingerprint: "d".repeat(64),
  nodeId: hello().nodeId,
  providerId: "offline-command",
  enforcementKeyId: "fixture-enforcer",
  ledgerId: randomUUID(),
});
const challenge = (binding: CommandPreparationBinding) => ({
  type: "work.command.prepare_challenge",
  protocolVersion: commandProtocolVersion,
  nodeId: binding.nodeId,
  preparationId: binding.preparationId,
  requestId: binding.preparationId,
  payload: { token: "header.payload.signature" },
});

it("negotiates commands once and correlates a single reply on the original opaque connection", async () => {
  const frames: CommandPending[] = [];
  const f = await fixture(undefined, {
    frame: (value) => {
      frames.push(value);
      return true;
    },
  });
  try {
    const p = await f.peer(),
      ack = await p.enroll(true);
    const commands = f.registry.commands!,
      handle = commands.connection(hello().nodeId),
      binding = preparation(handle.live.connectionId);
    expect(ack).toMatchObject({
      commandChannel: {
        protocolVersion: commandProtocolVersion,
        connectionId: handle.live.connectionId,
      },
    });
    const prepare: CommandServerFrame = {
      type: "work.command.prepare_open",
      protocolVersion: commandProtocolVersion,
      nodeId: binding.nodeId,
      preparationId: binding.preparationId,
      requestId: binding.preparationId,
      payload: binding,
    };
    await expect(commands.send({ ...handle }, prepare)).rejects.toThrow(
      "command_channel_unavailable",
    );
    await expect(
      commands.guard(handle, AbortSignal.timeout(3000), async () => commands.send(handle, prepare)),
    ).rejects.toThrow("command_channel_unavailable");
    await commands.send(handle, prepare);
    expect(await p.frame()).toEqual(prepare);
    p.send(challenge(binding));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const pending = frames[0]!;
    pending.frame.payload = { token: "changed.token.bytes" };
    expect(pending.frame.payload).toEqual({ token: "header.payload.signature" });
    const reply: CommandServerFrame = {
      ...prepare,
      type: "work.command.prepare_authorize",
      payload: { token: "response.payload.signature" },
    };
    await expect(commands.reply({ ...pending }, reply)).rejects.toThrow();
    await commands.reply(pending, reply);
    expect(await p.frame()).toEqual(reply);
    await expect(commands.reply(pending, reply)).rejects.toThrow();
    commands.complete(pending);
    expect(() => commands.complete(pending)).toThrow();
    p.send({
      type: "node.heartbeat",
      protocolVersion,
      nodeId: hello().nodeId,
      activeRunIds: [],
      sentAt: new Date().toISOString(),
    });
    expect(await p.frame()).not.toHaveProperty("commandChannel");
    const replacement = await f.peer();
    await replacement.enroll(true);
    expect(commands.connection(hello().nodeId).live.connectionId).not.toBe(
      handle.live.connectionId,
    );
    await expect(commands.send(handle, prepare)).rejects.toThrow();
    await expect(commands.send(commands.connection(hello().nodeId), prepare)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("closes unnegotiated commands, duplicate wire keys and a fifth unresolved observation", async () => {
  const frames: CommandPending[] = [];
  const f = await fixture(undefined, {
    frame: (value) => {
      frames.push(value);
      return true;
    },
  });
  try {
    const unnegotiated = await f.peer();
    await unnegotiated.enroll();
    let closed = once(unnegotiated.socket, "close");
    unnegotiated.send(challenge(preparation(randomUUID())));
    await closed;
    const duplicate = await f.peer();
    await duplicate.enroll(true);
    const binding = preparation(f.registry.commands!.connection(hello().nodeId).live.connectionId);
    closed = once(duplicate.socket, "close");
    duplicate.socket.send(JSON.stringify(challenge(binding)).replace("{", '{"nodeId":"shadow",'));
    await closed;
    expect(frames).toHaveLength(0);
    const flooded = await f.peer();
    await flooded.enroll(true);
    for (let index = 1; index <= 4; index++) {
      flooded.send(challenge(binding));
      await vi.waitFor(() => expect(frames).toHaveLength(index));
    }
    closed = once(flooded.socket, "close");
    flooded.send(challenge(binding));
    await closed;
    expect(f.registry.list()).toEqual([]);
  } finally {
    await f.close();
  }
});
