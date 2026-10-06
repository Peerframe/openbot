import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { type Duplex, PassThrough } from "node:stream";
import { type EntryOptions, forbiddenHeader, peerForwarded, safeRequestTarget } from "./config.js";

export function workerTunnel(server: Server | HttpsServer, options: EntryOptions): () => void {
  const tunnels = new Set<() => void>();
  const upstream = new URL(options.upstream);
  const publicHost = new URL(options.publicOrigin).host;
  let closing = false;
  function refuse(socket: Duplex, status: number) {
    socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
      socket.destroy(),
    );
  }
  function upgrade(incoming: IncomingMessage, client: Duplex, clientHead: Buffer) {
    // Rejected upgrades also own their socket; reset/error cannot escape into the process.
    client.on("error", () => client.destroy());
    if (closing || tunnels.size >= 32) return refuse(client, 503);
    if (
      !safeRequestTarget(incoming.url) ||
      incoming.url.split("?")[0] !== "/ws/nodes" ||
      incoming.method !== "GET" ||
      incoming.headers.host !== publicHost ||
      Object.keys(incoming.headers).some(forbiddenHeader) ||
      incoming.headers.upgrade?.toLowerCase() !== "websocket" ||
      clientHead.length > 65536
    ) {
      return refuse(client, 400);
    }
    let peer: string;
    try {
      peer = peerForwarded(incoming.socket.remoteAddress);
    } catch {
      return refuse(client, 400);
    }
    // Carry the HTTP handshake/frame bytes, never parse Worker messages or grant authority.
    // A bounded unread pipe handles pre-handshake buffering; Node's pipe provides
    // backpressure while still observing a client FIN with an empty pending queue.
    const pending = new PassThrough({ highWaterMark: 65536 });
    client.pipe(pending);
    const headers: string[] = [];
    const connection = String(incoming.headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase());
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      const name = incoming.rawHeaders[index],
        value = incoming.rawHeaders[index + 1];
      if (
        name &&
        value !== undefined &&
        !["host", "connection"].includes(name.toLowerCase()) &&
        !connection.filter((item) => item !== "upgrade").includes(name.toLowerCase())
      ) {
        headers.push(name, value);
      }
    }
    headers.push("Host", publicHost, "Connection", "Upgrade", "Forwarded", peer);
    const outgoing = httpRequest({
      hostname: upstream.hostname,
      port: upstream.port,
      method: "GET",
      path: incoming.url,
      headers,
      agent: false,
    });
    let remote: Duplex | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      tunnels.delete(finish);
      outgoing.destroy();
      pending.destroy();
      remote?.destroy();
      client.destroy();
    };
    const deadline = setTimeout(finish, 5000);
    deadline.unref();
    tunnels.add(finish);
    client.once("close", finish);
    client.once("end", finish);
    client.once("error", finish);
    outgoing.once("error", finish);
    outgoing.once("response", (response) => {
      // Preserve the private authority's bounded refusal. No retry or alternate target.
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 8192) finish();
        else chunks.push(Buffer.from(chunk));
      });
      const headers: string[] = [];
      const hop = String(response.headers.connection ?? "")
        .split(",")
        .map((name) => name.trim().toLowerCase());
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index];
        if (
          name &&
          !["connection", "content-length", "transfer-encoding", "trailer"].includes(
            name.toLowerCase(),
          ) &&
          !hop.includes(name.toLowerCase())
        ) {
          headers.push(`${name}: ${response.rawHeaders[index + 1]}\r\n`);
        }
      }
      response.once("end", () => {
        if (done) return;
        // IncomingMessage has removed HTTP chunk framing. Reframe only this bounded
        // refusal body; never buffer or reinterpret an accepted Worker byte stream.
        const head = Buffer.from(
          `HTTP/1.1 ${response.statusCode ?? 502} Refused\r\n${headers.join("")}Content-Length: ${bytes}\r\nConnection: close\r\n\r\n`,
        );
        client.end(Buffer.concat([head, ...chunks]));
      });
      response.once("error", finish);
    });
    outgoing.once("upgrade", (response, socket, remoteHead) => {
      if (done) {
        socket.destroy();
        return;
      }
      clearTimeout(deadline);
      remote = socket;
      remote.once("close", finish);
      remote.once("error", finish);
      const rawHeaders: string[] = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        rawHeaders.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
      }
      client.write(
        `HTTP/1.1 ${response.statusCode} Switching Protocols\r\n${rawHeaders.join("")}\r\n`,
      );
      if (remoteHead.length) client.write(remoteHead);
      if (clientHead.length) remote.write(clientHead);
      remote.pipe(client);
      pending.pipe(remote);
    });
    outgoing.end();
  }
  server.on("upgrade", upgrade);
  return () => {
    closing = true;
    server.off("upgrade", upgrade);
    for (const finish of tunnels) finish();
  };
}
