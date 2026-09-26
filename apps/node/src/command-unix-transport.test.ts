import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import type { CommandServerFrame } from "@openbot/protocol";
import { describe, expect, it } from "vitest";
import { attachJsonTransport } from "./bounded-json-transport.mjs";
import { unixCommandInstallation } from "./command-unix-transport.js";

const identity = "00000000-0000-4000-8000-000000000001";
const selection = {
  nodeId: "test-node",
  providerId: "test-provider",
  enforcementKeyId: "test-key",
  ledgerId: identity,
};
const frame: CommandServerFrame = {
  type: "work.command.error",
  protocolVersion: "0.10.0",
  nodeId: selection.nodeId,
  preparationId: identity,
  requestId: identity,
  payload: { status: "denied", code: "unavailable" },
};

describe.skipIf(process.platform === "win32")("installed command Unix transport", () => {
  it("uses one real Unix connection for bounded two-way frames, then closes on Abort", async () => {
    const directory = await mkdtemp("/tmp/openbot-cux-");
    const path = `${directory}/host.sock`;
    const peers = new Set<Socket>();
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      peers.add(socket);
      socket.once("close", () => peers.delete(socket));
      const peer = attachJsonTransport(socket, {
        onMessage: (value: unknown) => peer.send(value),
      });
    });
    const abort = new AbortController();
    try {
      server.listen(path);
      await once(server, "listening");
      let received: (value: unknown) => void = () => undefined;
      const answer = new Promise<unknown>((resolve) => {
        received = resolve;
      });
      let closed: () => void = () => undefined;
      const closure = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const transport = await unixCommandInstallation(path, selection).openTransport({
        signal: abort.signal,
        connectionId: identity,
        onMessage: async (value) => received(value),
        onClose: closed,
      });
      await transport.send(frame);
      expect(await answer).toEqual(frame);
      expect(connections).toBe(1);
      abort.abort();
      await closure;
      await expect(transport.send(frame)).rejects.toMatchObject({
        code: "ERR_JSON_TRANSPORT_ABORTED",
      });
      expect(connections).toBe(1);
    } finally {
      abort.abort();
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an already aborted connection and an absent socket without a retry", async () => {
    const directory = await mkdtemp("/tmp/openbot-cux-");
    try {
      const installation = unixCommandInstallation(`${directory}/missing.sock`, selection);
      const callbacks = {
        connectionId: identity,
        onMessage: async () => undefined,
        onClose: () => undefined,
      };
      await expect(
        installation.openTransport({ ...callbacks, signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ code: "aborted" });
      await expect(
        installation.openTransport({ ...callbacks, signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: "io_failed" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["relative.sock", "/a/../host.sock", "/a/./host.sock", "/a\0b", `/${"a".repeat(104)}`])(
    "refuses a noncanonical or unbounded installation path %j",
    (path) =>
      expect(() => unixCommandInstallation(path, selection)).toThrow("command_relay_invalid_frame"),
  );
});
