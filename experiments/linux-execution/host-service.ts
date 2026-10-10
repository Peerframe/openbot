/** One accepted protected Unix relay; peer identity comes from the kernel, never the request. */
import { chownSync, chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { Host } from "./protected-host.ts";
import { receive, requireFact, send } from "./protected-io.ts";
import { peerUid } from "./kernel-facts.ts";
export class UnixService {
  readonly host: Host;
  readonly peer: (socket: Socket) => number;
  constructor(host: Host, peer = peerUid) {
    this.host = host;
    this.peer = peer;
  }
  async connection(socket: Socket) {
    try {
      requireFact(this.peer(socket) === this.host.config.nodeUid, "peer_refused");
      socket.setTimeout(60000, () => socket.destroy(new Error("relay_timeout")));
      for await (const value of receive(socket))
        for (const response of await this.host.handle(value)) await send(socket, response);
    } finally {
      this.host.close();
      socket.destroy();
    }
  }
  async serve() {
    const path = this.host.config.socketPath;
    try {
      lstatSync(path);
      throw new Error("socket_exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let failure: unknown, acceptedSocket: Socket | undefined;
    let bound: ReturnType<typeof lstatSync> | undefined,
      accepted = false;
    let finish!: () => void, fail!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // A connection can arrive immediately after listen. Keep rejection observed during chmod.
    void done.catch(() => {});
    const server = createServer((socket) => {
      if (accepted) {
        socket.destroy();
        return;
      }
      accepted = true;
      acceptedSocket = socket;
      server.close();
      void this.connection(socket).then(finish, fail);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      server.on("error", fail);
      bound = lstatSync(path);
      chownSync(path, 0, this.host.config.nodeGid);
      chmodSync(path, 0o660);
      await done;
    } catch (error) {
      failure = error;
    } finally {
      acceptedSocket?.destroy();
      server.close();
      this.host.close();
      if (bound) {
        try {
          const current = lstatSync(path);
          if (current.isSocket() && current.dev === bound.dev && current.ino === bound.ino)
            unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= error;
        }
      }
    }
    if (failure) throw failure;
  }
}
