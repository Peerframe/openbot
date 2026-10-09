import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { createServer, request as httpsRequest, type RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicWorkWeb } from "../apps/server-ts/dist/public-work-web.js";
import { issueTlsFixture } from "./tls-fixture.ts";
export async function workWebFixture() {
  const directory = await mkdtemp(join(tmpdir(), "openbot-web-peer-"));
  try {
    const paths = await issueTlsFixture(directory),
      ca = await readFile(paths.caPath);
    const requests: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
    let mode = "normal";
    let body: Buffer = Buffer.from(
      "<h1>Synthetic page</h1><p>Readable &amp; bounded evidence</p><script>PRIVATE</script>",
    );
    const server = createServer(
      { cert: await readFile(paths.certificatePath), key: await readFile(paths.privateKeyPath) },
      async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push({
          url: request.url!,
          headers: request.headers,
          body: Buffer.concat(chunks).toString(),
        });
        if (mode === "drop") {
          response.destroy();
          return;
        }
        if (mode === "redirect") {
          response.writeHead(302, { Location: "https://example.org/redirect" });
          response.end();
          return;
        }
        const search = request.url === "/search" || request.url?.includes("/fibers");
        response.writeHead(200, {
          "Content-Type": search ? "application/json" : "text/html; charset=utf-8",
          ...(mode === "encoding" ? { "Content-Encoding": "gzip" } : {}),
        });
        if (search) {
          response.end(
            JSON.stringify(
              request.url === "/search"
                ? {
                    results: [
                      {
                        url: "https://example.com/evidence",
                        title: "Synthetic result",
                        content: "Synthetic search evidence",
                      },
                    ],
                  }
                : { status: "succeeded", context: { output: "Synthetic Kimi search evidence" } },
            ),
          );
        } else response.end(mode === "large" ? Buffer.alloc(524289, 97) : body);
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing web fixture");
    const resolver = async () => [{ address: "8.8.8.8", family: 4 }];
    const transport = ((
      url: URL,
      options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      assert.equal(options.rejectUnauthorized, true);
      assert(options.lookup);
      options.lookup(url.hostname, { all: true }, (_error, addresses) => {
        assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
      });
      // Trusted test socket mapping only; production has no local-network exception or endpoint flag.
      return httpsRequest(
        new URL(`https://127.0.0.1:${address.port}${url.pathname}${url.search}`),
        { ...options, agent: false, servername: "entry.test", ca },
        callback,
      );
    }) as typeof httpsRequest;
    return {
      client: new PublicWorkWeb(resolver, transport),
      requests,
      setMode: (value: string) => {
        mode = value;
      },
      setBody: (value: Buffer) => {
        body = value;
      },
      async close() {
        server.closeAllConnections();
        server.close();
        await once(server, "close");
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
