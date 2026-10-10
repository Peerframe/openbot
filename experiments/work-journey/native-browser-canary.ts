/** Synthetic, owned HTTP/TLS page for native browser acceptance; never calls an external service. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { browserCanaryPage } from "./native-browser-page.ts";
export async function openBrowserCanary(
  options: {
    host?: string;
    httpPort?: number;
    tlsDirectory?: string;
    tlsPorts?: [number, number];
  } = {},
) {
  const state: Record<string, unknown> = { text: "", submitted: 0, stored: "" };
  let hits = 0;
  const servers: Server[] = [];
  const send = (
    response: ServerResponse,
    status: number,
    body: string,
    kind = "application/json",
  ) => {
    response.writeHead(status, { "content-type": kind, "content-length": Buffer.byteLength(body) });
    response.end(body);
  };
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET") {
      if (request.url === "/state") send(response, 200, JSON.stringify(state));
      else if (request.url === "/hits") send(response, 200, JSON.stringify({ requests: hits }));
      else {
        assert(Number.isSafeInteger(++hits));
        send(
          response,
          200,
          request.url === "/tunnel" ? "owned-tunnel" : browserCanaryPage,
          request.url === "/tunnel" ? "text/plain" : "text/html; charset=utf-8",
        );
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/event") {
      send(response, 404, "{}");
      request.resume();
      return;
    }
    const length = Number(request.headers["content-length"]);
    assert(
      Number.isSafeInteger(length) &&
        length > 0 &&
        length <= 4096 &&
        request.headers["transfer-encoding"] === undefined,
    );
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const part of request) {
      const bytes = Buffer.from(part);
      total += bytes.length;
      assert(total <= length);
      chunks.push(bytes);
    }
    assert.equal(total, length);
    const event: unknown = JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    assert(event && typeof event === "object" && !Array.isArray(event));
    for (const [key, value] of Object.entries(event)) {
      assert(
        ["text", "submitted", "stored", "persistentCookie", "sessionCookie", "indexedDB"].includes(
          key,
        ),
      );
      assert(
        key === "submitted"
          ? Number.isSafeInteger(value) && Number(value) >= 0
          : key.endsWith("Cookie")
            ? typeof value === "boolean"
            : typeof value === "string",
      );
    }
    Object.assign(state, event);
    send(response, 200, "ok", "text/plain");
  };
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent) send(response, 400, "{}");
      else response.destroy();
      request.resume();
    });
  };
  async function listen(server: Server, port: number) {
    server.requestTimeout = 3000;
    server.headersTimeout = 3000;
    server.maxConnections = 64;
    server.setTimeout(3000, (socket) => socket.destroy());
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, options.host ?? "::", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    return address.port;
  }
  async function close() {
    await Promise.all(
      servers.map(async (server) => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
              ? reject(error)
              : resolve(),
          ),
        );
      }),
    );
  }
  try {
    const http = await listen(createServer(listener), options.httpPort ?? 18080),
      tls: number[] = [];
    if (options.tlsDirectory)
      for (const [index, prefix] of ["", "unknown-"].entries())
        tls.push(
          await listen(
            createTlsServer(
              {
                cert: readFileSync(options.tlsDirectory + "/" + prefix + "cert.pem"),
                key: readFileSync(options.tlsDirectory + "/" + prefix + "key.pem"),
                minVersion: "TLSv1.2",
              },
              listener,
            ),
            options.tlsPorts?.[index] ?? (index ? 18444 : 18443),
          ),
        );
    return { http, tls, close };
  } catch (error) {
    await close();
    throw error;
  }
}
