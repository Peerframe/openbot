import { describe, expect, it, vi } from "vitest";
import {
  CommandRelay,
  type CommandRelayInstallation,
  type CommandRelayTransport,
  type CommandRelayWebSocket,
} from "./command-relay.js";

const id = "11111111-1111-1111-1111-111111111111";
const selected = { nodeId: "node", providerId: "provider", enforcementKeyId: "key", ledgerId: id };
const frame = (type = "work.command.prepare_authorize", payload: unknown = { token: "a.b.c" }) => ({
  type,
  protocolVersion: "0.10.0",
  nodeId: "node",
  preparationId: id,
  requestId: id,
  payload,
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function setup(
  options: { blockedSend?: boolean; blockedOpen?: boolean; blockedSocket?: boolean } = {},
) {
  const controller = new AbortController();
  let current = true;
  const messages: string[] = [];
  const hostMessages: unknown[] = [];
  const closed: string[] = [];
  const sendBlock = pending<void>();
  const openBlock = pending<CommandRelayTransport>();
  let hooks!: Parameters<CommandRelayInstallation["openTransport"]>[0];
  const callbacks: ((error?: Error) => void)[] = [];
  const socket: CommandRelayWebSocket = {
    readyState: 1,
    bufferedAmount: 0,
    send(text, callback) {
      messages.push(text);
      callbacks.push(callback);
      if (!options.blockedSocket) callback();
    },
  };
  const transport = {
    send: vi.fn(async (value: unknown) => {
      hostMessages.push(value);
      if (options.blockedSend) await sendBlock.promise;
    }),
    close: vi.fn(),
  };
  const installation: CommandRelayInstallation = {
    selection: selected,
    openTransport: vi.fn(async (value) => {
      hooks = value;
      return options.blockedOpen ? openBlock.promise : transport;
    }),
  };
  const relay = new CommandRelay(
    installation,
    socket,
    () => current,
    controller.signal,
    id,
    (code) => closed.push(code),
  );
  return {
    relay,
    controller,
    messages,
    hostMessages,
    closed,
    sendBlock,
    openBlock,
    transport,
    installation,
    socket,
    callbacks,
    stale() {
      current = false;
    },
    hooks: () => hooks,
  };
}

describe("default-off connection-owned command relay", () => {
  it("forwards both directions once and keeps JWT strings opaque", async () => {
    const h = setup();
    try {
      await h.relay.receiveServer(bytes(frame()));
      expect(h.hostMessages).toEqual([frame()]);
      await h.hooks().onMessage(frame("work.command.ready"));
      expect(JSON.parse(h.messages[0] ?? "")).toEqual(frame("work.command.ready"));
      expect(h.installation.openTransport).toHaveBeenCalledTimes(1);
    } finally {
      h.relay.close();
    }
  });
  it("refused and lookup_required observations trigger no retry/lookup/command", async () => {
    const h = setup();
    try {
      for (const status of ["denied", "lookup_required"]) {
        await h.relay.receiveServer(
          bytes(frame("work.command.consume_result", { status, code: "lookup_required" })),
        );
        await h.hooks().onMessage(frame("work.command.error", { status, code: "lookup_required" }));
      }
      expect(h.transport.send).toHaveBeenCalledTimes(2);
      expect(h.messages).toHaveLength(2);
    } finally {
      h.relay.close();
    }
  });
  it("forwards input on the same connection after authorize without waiting for ready", async () => {
    const h = setup();
    const input = frame("work.command.input_chunk", {
      fileIndex: 0,
      offset: 0,
      data: Buffer.from("synthetic").toString("base64"),
    });
    try {
      await h.relay.receiveServer(bytes(frame()));
      await h.relay.receiveServer(bytes(input));
      expect(h.hostMessages).toEqual([frame(), input]);
      expect(h.messages).toEqual([]);
      await h.hooks().onMessage(frame("work.command.input_ack", { fileIndex: 0, nextOffset: 9 }));
      await h.hooks().onMessage(frame("work.command.ready"));
      expect(h.messages.map((value) => JSON.parse(value).type)).toEqual([
        "work.command.input_ack",
        "work.command.ready",
      ]);
      expect(h.installation.openTransport).toHaveBeenCalledTimes(1);
    } finally {
      h.relay.close();
    }
  });
  it("replaces no socket after asynchronous validation/write", async () => {
    const old = setup({ blockedSend: true });
    const replacement = setup();
    try {
      const result = old.relay.receiveServer(bytes(frame()));
      const rejected = expect(result).rejects.toThrow("stale_connection");
      await tick();
      old.stale();
      old.sendBlock.resolve();
      await rejected;
      await expect(old.hooks().onMessage(frame("work.command.ready"))).rejects.toThrow();
      expect(old.messages).toEqual([]);
      expect(replacement.messages).toEqual([]);
      expect(replacement.hostMessages).toEqual([]);
      expect(old.transport.send).toHaveBeenCalledTimes(1);
      expect(old.transport.close).toHaveBeenCalledTimes(1);
    } finally {
      old.relay.close();
      replacement.relay.close();
    }
  });
  it("checks identity before dispatch to the captured socket", async () => {
    const h = setup();
    try {
      await tick();
      h.stale();
      await expect(h.hooks().onMessage(frame("work.command.ready"))).rejects.toThrow(
        "stale_connection",
      );
      expect(h.messages).toEqual([]);
    } finally {
      h.relay.close();
    }
  });
  it("closes a late opening transport after Abort and never flushes queued frames", async () => {
    const h = setup({ blockedOpen: true });
    const work = h.relay.receiveServer(bytes(frame()));
    const rejected = expect(work).rejects.toThrow("aborted");
    await tick();
    h.controller.abort();
    await rejected;
    h.openBlock.resolve(h.transport);
    await tick();
    expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(h.hostMessages).toEqual([]);
    expect(h.closed).toEqual(["aborted"]);
  });
  it("does not open when signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    const installation = { selection: selected, openTransport: vi.fn() };
    const relay = new CommandRelay(
      installation,
      { readyState: 1, bufferedAmount: 0, send: vi.fn() },
      () => true,
      c.signal,
      id,
    );
    await tick();
    expect(installation.openTransport).not.toHaveBeenCalled();
    relay.close();
  });
  it("caps incoming queued messages including the active unresolved send", async () => {
    const h = setup({ blockedSend: true });
    const tasks = Array.from({ length: 5 }, () =>
      h.relay.receiveServer(bytes(frame())).catch((error) => error.message),
    );
    expect(await Promise.all(tasks)).toEqual(Array(5).fill("command_relay_queue_full"));
    h.sendBlock.resolve();
    await tick();
    expect(h.transport.send.mock.calls.length).toBeLessThanOrEqual(1);
    expect(h.closed).toEqual(["queue_full"]);
  });
  it("caps incoming queued bytes before a fifth message", async () => {
    const h = setup({ blockedSend: true });
    const chunk = frame("work.command.input_chunk", {
      fileIndex: 0,
      offset: 0,
      data: Buffer.alloc(16384).toString("base64"),
    });
    const tasks = Array.from({ length: 3 }, () =>
      h.relay.receiveServer(bytes(chunk)).catch((error) => error.message),
    );
    expect(await Promise.all(tasks)).toEqual(Array(3).fill("command_relay_queue_full"));
    h.sendBlock.resolve();
  });
  it("caps outgoing messages and bytes while WS callbacks are blocked", async () => {
    for (const byteLimit of [false, true]) {
      const h = setup({ blockedSocket: true });
      await tick();
      const value = byteLimit
        ? frame("work.command.output_chunk", {
            fileIndex: 0,
            offset: 0,
            data: Buffer.alloc(16384).toString("base64"),
          })
        : frame("work.command.ready");
      const tasks = Array.from({ length: byteLimit ? 3 : 5 }, () =>
        h
          .hooks()
          .onMessage(value)
          .catch((error) => error.message),
      );
      expect(await Promise.all(tasks)).toEqual(
        Array(byteLimit ? 3 : 5).fill("command_relay_queue_full"),
      );
      for (const callback of h.callbacks) callback();
      await tick();
      expect(h.messages.length).toBeLessThanOrEqual(1);
    }
  });
  it("rejects a socket's preexisting backlog without adding output", async () => {
    const h = setup();
    await tick();
    Object.assign(h.socket, { bufferedAmount: 65536 });
    await expect(h.hooks().onMessage(frame("work.command.ready"))).rejects.toThrow("queue_full");
    expect(h.messages).toEqual([]);
  });
  it("bounds all pending work by local I/O timeout without retry", async () => {
    vi.useFakeTimers();
    const h = setup({ blockedSend: true });
    try {
      const result = h.relay.receiveServer(bytes(frame())).catch((error) => error.message);
      await vi.advanceTimersByTimeAsync(5001);
      expect(await result).toBe("command_relay_io_timeout");
      expect(h.transport.send.mock.calls.length).toBeLessThanOrEqual(1);
      expect(h.transport.close).toHaveBeenCalledTimes(1);
      h.sendBlock.resolve();
    } finally {
      h.relay.close();
      vi.useRealTimers();
    }
  });
  it("preserves unknown send failure without resending", async () => {
    const h = setup({ blockedSend: true });
    const work = h.relay.receiveServer(bytes(frame()));
    const rejected = expect(work).rejects.toThrow("io_failed");
    await tick();
    h.sendBlock.reject(new Error("synthetic-private-error"));
    await rejected;
    expect(h.closed).toEqual(["io_failed"]);
    expect(h.transport.send).toHaveBeenCalledTimes(1);
    await expect(h.relay.receiveServer(bytes(frame()))).rejects.toThrow("io_failed");
    expect(h.transport.send).toHaveBeenCalledTimes(1);
  });
  it("keeps a failed WS write unknown and never repeats the observation", async () => {
    const h = setup({ blockedSocket: true });
    await tick();
    const result = h.hooks().onMessage(frame("work.command.ready"));
    const rejected = expect(result).rejects.toThrow("io_failed");
    await tick();
    for (const callback of h.callbacks) callback(new Error("synthetic-private-error"));
    await rejected;
    await expect(h.hooks().onMessage(frame("work.command.ready"))).rejects.toThrow("io_failed");
    expect(h.messages).toHaveLength(1);
    expect(h.closed).toEqual(["io_failed"]);
    expect(h.transport.close).toHaveBeenCalledTimes(1);
  });
  it("drains no queue on transport close or disconnect Abort", async () => {
    for (const close of ["transport", "abort"]) {
      const h = setup({ blockedSocket: true });
      await tick();
      const work = h
        .hooks()
        .onMessage(frame("work.command.ready"))
        .catch((error) => error.message);
      await tick();
      if (close === "transport") h.hooks().onClose();
      else h.controller.abort();
      expect(await work).toContain(close === "transport" ? "io_failed" : "aborted");
      for (const callback of h.callbacks) callback();
      h.relay.close();
      expect(h.closed).toHaveLength(1);
      expect(h.messages).toHaveLength(1);
    }
  });
  it("rejects binary UTF8/BOM/oversize/malformed/value and wrong direction or Node", async () => {
    for (const bad of [
      new Uint8Array([255]),
      new Uint8Array([239, 187, 191, ...bytes(frame())]),
      new Uint8Array(32769),
      bytes(null),
      bytes({}),
      bytes({ ...frame(), nodeId: "another" }),
      bytes(frame("work.command.ready")),
    ]) {
      const h = setup();
      await expect(h.relay.receiveServer(bad)).rejects.toThrow("invalid_frame");
      expect(h.hostMessages).toEqual([]);
      h.relay.close();
    }
  });
  it("checks clear routing fields against the trusted selected enforcer", async () => {
    const binding = {
      ...selected,
      taskId: "t",
      runId: "r",
      actionId: "a",
      preparationId: id,
      connectionId: id,
      originalEpoch: 1,
      authorityGeneration: 1,
      profileDigest: "a".repeat(64),
      intentDigest: "b".repeat(64),
      operationFingerprint: "c".repeat(64),
    };
    for (const key of ["providerId", "enforcementKeyId", "ledgerId", "connectionId"] as const) {
      const h = setup();
      const value = {
        ...binding,
        [key]: key === "ledgerId" || key === "connectionId" ? id.replaceAll("1", "2") : "other",
      };
      await expect(
        h.relay.receiveServer(bytes(frame("work.command.prepare_open", value))),
      ).rejects.toThrow("invalid_frame");
      expect(h.hostMessages).toEqual([]);
      h.relay.close();
    }
  });
  it("snapshots queued caller bytes and host objects", async () => {
    const h = setup({ blockedOpen: true });
    const raw = bytes(frame());
    const send = h.relay.receiveServer(raw);
    raw.fill(255);
    await tick();
    h.openBlock.resolve(h.transport);
    await send;
    expect(h.hostMessages).toEqual([frame()]);
    const value = frame("work.command.ready");
    const observed = h.hooks().onMessage(value);
    value.nodeId = "mutated";
    await observed;
    expect(JSON.parse(h.messages[0] ?? "").nodeId).toBe("node");
    h.relay.close();
  });
  it("documents untrusted Node JSON normalization rather than claiming signed authority", async () => {
    const h = setup();
    try {
      const raw = JSON.stringify(frame("work.command.input_ack", { fileIndex: 0, nextOffset: 1 }));
      // Server direction uses output_ack. Node's decoded-value layer can normalize duplicate keys and1.0.
      const normalized = raw
        .replace("input_ack", "output_ack")
        .replace('"nodeId":"node"', '"nodeId":"ignored","nodeId":"node"')
        .replace('"nextOffset":1', '"nextOffset":1.0');
      await h.relay.receiveServer(new TextEncoder().encode(normalized));
      expect(h.hostMessages).toEqual([
        frame("work.command.output_ack", { fileIndex: 0, nextOffset: 1 }),
      ]);
      // This is not an enforcer acceptance test. Independent strict Host/signed-operation checks are mandatory.
    } finally {
      h.relay.close();
    }
  });
});
