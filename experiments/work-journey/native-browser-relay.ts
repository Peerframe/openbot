/** Fixed-destination relay for the disposable native browser; no routing or proxy authority. */
import assert from "node:assert/strict";
import {
  createConnection,
  createServer,
  type ListenOptions,
  type NetConnectOpts,
  type Socket,
} from "node:net";

export async function openNativeRelay(listen: ListenOptions, destination: NetConnectOpts) {
  const peers = new Set<Socket>();
  const server = createServer((client) => {
    if (peers.size >= 128) {
      client.destroy();
      return;
    }
    const remote = createConnection(destination);
    peers.add(client);
    peers.add(remote);
    let count = 0,
      connected = false;
    const drains = new Set<ReturnType<typeof setTimeout>>();
    const deadline = setTimeout(() => close(), 90000);
    const close = () => {
      clearTimeout(deadline);
      for (const timer of drains) clearTimeout(timer);
      drains.clear();
      client.destroy();
      remote.destroy();
      peers.delete(client);
      peers.delete(remote);
    };
    const bound = (bytes: Buffer) => {
      count += bytes.length;
      if (count > 2 * 1024 * 1024) close();
    };
    client.on("error", close);
    remote.on("error", close);
    client.on("close", close);
    remote.on("close", close);
    client.on("data", bound);
    remote.on("data", bound);
    remote.setTimeout(3000, close);
    for (const source of [client, remote]) {
      let pending: ReturnType<typeof setTimeout> | undefined;
      const clear = () => {
        if (pending) {
          clearTimeout(pending);
          drains.delete(pending);
          pending = undefined;
        }
      };
      source.on("pause", () => {
        if (!connected || source.destroyed || pending) return;
        pending = setTimeout(close, 3000);
        drains.add(pending);
      });
      source.on("resume", clear);
      source.on("close", clear);
    }
    remote.once("connect", () => {
      connected = true;
      remote.setTimeout(0);
      client.pipe(remote);
      remote.pipe(client);
    });
    // Pause before connection so an eager HTTP request cannot be lost to the bound observer.
    client.pause();
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen, () => resolve());
  });
  try {
    await ready;
  } catch (error) {
    for (const peer of peers) peer.destroy();
    server.close();
    throw error;
  }
  return {
    server,
    address() {
      const address = server.address();
      assert(address);
      return address;
    },
    async close() {
      for (const peer of peers) peer.destroy();
      peers.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
