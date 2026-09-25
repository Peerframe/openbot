import { afterEach, describe, expect, it, vi } from "vitest";

const sockets = vi.hoisted(() => [] as MockSocket[]);
interface MockSocket {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  emit(event: string, ...args: unknown[]): boolean;
  close(): void;
}
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      static OPEN = 1;
      static CLOSED = 3;
      static CLOSING = 2;
      readyState = 1;
      bufferedAmount = 0;
      sent: string[] = [];
      constructor() {
        super();
        sockets.push(this);
      }
      send(value: string, callback?: (error?: Error) => void) {
        this.sent.push(value);
        callback?.();
      }
      close() {
        this.readyState = 3;
        this.emit("close");
      }
    },
  };
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture");
  return value;
}
vi.mock("./providers.js", () => ({
  configuredProviders: () => [],
  availableCapabilities: () => [],
  availableCapabilityManifest: () => [],
  providerForProfile: () => undefined,
}));
vi.mock("./host.js", () => ({
  detectWorkerHost: () => ({ platform: "linux", architecture: "x64" }),
}));
vi.mock("./credential-store.js", () => ({
  createNodeCredentialStore: () => {
    throw new Error("unexpected ambient store");
  },
}));
vi.mock("./browser-host.js", () => ({
  BrowserCommandHost: class {
    disconnect() {}
  },
}));

import type { NodeEnv } from "@openbot/config";
import type { OpenBotLogger } from "@openbot/logging";
import { OpenBotNodeClient } from "./client.js";
import type { CommandRelayInstallation, CommandRelayTransport } from "./command-relay.js";

const id = "11111111-1111-1111-1111-111111111111";
const ack = {
  type: "server.ack",
  protocolVersion: "0.9.0",
  accepted: true,
  receivedAt: "2026-09-25T00:00:00.000Z",
};
const negotiatedAck = { ...ack, commandChannel: { protocolVersion: "0.10.0", connectionId: id } };
const command = {
  type: "work.command.prepare_authorize",
  protocolVersion: "0.10.0",
  nodeId: "node",
  requestId: id,
  preparationId: id,
  payload: { token: "a.b.c" },
};
const emit = (socket: MockSocket, value: unknown) =>
  socket.emit("message", Buffer.from(JSON.stringify(value)), false);
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as OpenBotLogger;
function client(installation?: CommandRelayInstallation) {
  return new OpenBotNodeClient(
    {
      OPENBOT_NODE_ID: "node",
      OPENBOT_NODE_SERVER_URL: "ws://synthetic.invalid/",
      OPENBOT_NODE_MAX_CONCURRENT_RUNS: 1,
    } as NodeEnv,
    [],
    {
      load: async () => ({
        nodeId: "node",
        credential: `obn_${"a".repeat(43)}`,
        protocolVersion: "0.9.0",
        issuedAt: "2026-09-25T00:00:00.000Z",
      }),
      save: vi.fn(),
    },
    logger,
    installation,
  );
}
function installed() {
  let hooks!: Parameters<CommandRelayInstallation["openTransport"]>[0];
  const transports: CommandRelayTransport[] = [];
  const selection = {
    nodeId: "node",
    providerId: "provider",
    enforcementKeyId: "key",
    ledgerId: id,
  };
  const install = {
    selection,
    openTransport: vi.fn(async (h: typeof hooks) => {
      hooks = h;
      const value = { send: vi.fn(async () => undefined), close: vi.fn() };
      transports.push(value);
      return value;
    }),
  };
  return { install, transports, hooks: () => hooks };
}
afterEach(() => {
  sockets.length = 0;
  vi.useRealTimers();
});
describe("optional command client integration without live sockets", () => {
  it("does nothing by default and advertises no command capability", async () => {
    const c = client();
    await c.start();
    const socket = required(sockets[0]);
    socket.emit("open");
    emit(socket, ack);
    emit(socket, command);
    await tick();
    const hello = JSON.parse(required(socket.sent[0]));
    expect(hello.protocolVersion).toBe("0.9.0");
    expect(hello.commandChannel).toBeUndefined();
    expect(hello.capabilityManifest).toEqual([]);
    expect(socket.sent).toHaveLength(1);
    await c.stop();
  });
  it("opens once only after accepted ACK and preserves original WS replies", async () => {
    const h = installed();
    const c = client(h.install);
    await c.start();
    const socket = required(sockets[0]);
    socket.emit("open");
    expect(JSON.parse(required(socket.sent[0])).commandChannel).toEqual({
      protocolVersion: "0.10.0",
    });
    emit(socket, command);
    await tick();
    expect(h.install.openTransport).not.toHaveBeenCalled();
    emit(socket, negotiatedAck);
    emit(socket, ack);
    await tick();
    emit(socket, command);
    await tick();
    expect(h.install.openTransport).toHaveBeenCalledTimes(1);
    expect(h.hooks().connectionId).toBe(id);
    expect(required(h.transports[0]).send).toHaveBeenCalledTimes(1);
    await h.hooks().onMessage({ ...command, type: "work.command.ready" });
    expect(JSON.parse(required(socket.sent.at(-1)))).toEqual({
      ...command,
      type: "work.command.ready",
    });
    await c.stop();
    expect(required(h.transports[0]).close).toHaveBeenCalledTimes(1);
  });
  it("does not reopen a failed relay on repeated ACK", async () => {
    const h = installed();
    const c = client(h.install);
    await c.start();
    const socket = required(sockets[0]);
    emit(socket, negotiatedAck);
    await tick();
    h.hooks().onClose();
    emit(socket, ack);
    emit(socket, command);
    await tick();
    expect(h.install.openTransport).toHaveBeenCalledTimes(1);
    expect(required(h.transports[0]).send).not.toHaveBeenCalled();
    await c.stop();
  });
  it("uses a fresh relay after WS reconnect and refuses old callback/request replay", async () => {
    vi.useFakeTimers();
    const h = installed();
    const c = client(h.install);
    await c.start();
    const old = required(sockets[0]);
    emit(old, negotiatedAck);
    await tick();
    const oldHooks = h.hooks();
    emit(old, command);
    await tick();
    old.close();
    await vi.advanceTimersByTimeAsync(2001);
    const replacement = required(sockets[1]);
    emit(replacement, {
      ...negotiatedAck,
      commandChannel: { protocolVersion: "0.10.0", connectionId: id.replaceAll("1", "2") },
    });
    await tick();
    await expect(oldHooks.onMessage({ ...command, type: "work.command.ready" })).rejects.toThrow();
    emit(old, command);
    await tick();
    expect(required(h.transports[0]).send).toHaveBeenCalledTimes(1);
    expect(required(h.transports[1]).send).not.toHaveBeenCalled();
    expect(replacement.sent).toEqual([]);
    await c.stop();
    expect(h.install.openTransport).toHaveBeenCalledTimes(2);
    expect(h.hooks().connectionId).toBe(id.replaceAll("1", "2"));
  });
  it.each(["missing", "unsolicited", "wrong-version", "invalid-id", "extra", "repeated"])(
    "refuses %s negotiation without opening or replacing a transport",
    async (mode) => {
      const h = installed();
      const c = client(mode === "unsolicited" ? undefined : h.install);
      await c.start();
      const socket = required(sockets[0]);
      let value: unknown = negotiatedAck;
      if (mode === "missing") value = ack;
      if (mode === "wrong-version")
        value = {
          ...negotiatedAck,
          commandChannel: { protocolVersion: "0.9.0", connectionId: id },
        };
      if (mode === "invalid-id")
        value = {
          ...negotiatedAck,
          commandChannel: { protocolVersion: "0.10.0", connectionId: "bad" },
        };
      if (mode === "extra")
        value = {
          ...negotiatedAck,
          commandChannel: { ...negotiatedAck.commandChannel, extra: true },
        };
      if (mode === "repeated") {
        emit(socket, negotiatedAck);
        await tick();
      }
      emit(socket, value);
      await tick();
      expect(socket.readyState).toBe(3);
      expect(h.install.openTransport).toHaveBeenCalledTimes(mode === "repeated" ? 1 : 0);
      await c.stop();
    },
  );
  it("refuses a trusted install selection for another Node before identity I/O", () => {
    const h = installed();
    h.install.selection.nodeId = "other";
    expect(() => client(h.install)).toThrow("different Node");
    expect(h.install.openTransport).not.toHaveBeenCalled();
  });
});
