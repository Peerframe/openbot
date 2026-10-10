import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, it, vi } from "vitest";
import { contractPluginFixture } from "../../../scripts/contract-plugin-fixture.ts";
import { PluginTransport, readPluginContent, withPlugin } from "./plugin-transport.js";
it("pins one explicit local endpoint, strips ambient authority, bounds bytes and terminates the session", async () => {
  let count = 0,
    mode = "normal",
    deleted = 0;
  const server = createServer((request, response) => {
    count++;
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.authorization).toBe("Bearer synthetic-token");
    if (request.method === "DELETE") {
      deleted++;
      expect(request.headers["mcp-session-id"]).toBe("owned-session");
      response.writeHead(204);
      response.end();
      return;
    }
    if (mode === "redirect") {
      response.writeHead(307, { Location: "https://example.com/unfollowed" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Mcp-Session-Id": "owned-session",
      ...(mode === "encoding" ? { "Content-Encoding": "gzip" } : {}),
    });
    response.end(mode === "large" ? "x".repeat(262145) : "{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`,
    transport = new PluginTransport(
      endpoint,
      "synthetic-token",
      [endpoint],
      new AbortController().signal,
    );
  try {
    expect((await transport.fetch(endpoint, { method: "GET" })).status).toBe(405);
    expect(count).toBe(0);
    expect(
      (
        await transport.fetch(endpoint, {
          method: "POST",
          headers: { Cookie: "untrusted", Authorization: "ignored" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
    await expect(
      transport.fetch(endpoint + "/other", { method: "POST", body: "{}" }),
    ).rejects.toThrow();
    await expect(
      transport.fetch(endpoint, { method: "POST", body: "x".repeat(24577) }),
    ).rejects.toThrow();
    expect(count).toBe(1);
    for (const value of ["redirect", "large", "encoding"]) {
      mode = value;
      await expect(transport.fetch(endpoint, { method: "POST", body: "{}" })).rejects.toThrow();
    }
    expect(count).toBe(4);
    await transport.finish();
    expect(deleted).toBe(1);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
it("refuses a mixed public/private DNS answer before opening a socket", async () => {
  const resolve = async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  const transport = new PluginTransport(
    "https://example.com/mcp",
    undefined,
    [],
    new AbortController().signal,
    resolve,
  );
  await expect(
    transport.fetch("https://example.com/mcp", { method: "POST", body: "{}" }),
  ).rejects.toMatchObject({ status: 403 });
});
it("cancellation settles an unresolved resolver without sending a request later", async () => {
  let finish: ((value: { address: string; family: number }[]) => void) | undefined;
  const resolve = () =>
      new Promise<{ address: string; family: number }[]>((r) => {
        finish = r;
      }),
    abort = new AbortController();
  const transport = new PluginTransport(
    "https://example.com/mcp",
    undefined,
    [],
    abort.signal,
    resolve,
  );
  const request = transport.fetch("https://example.com/mcp", { method: "POST", body: "{}" });
  const refused = expect(request).rejects.toThrow();
  abort.abort();
  await refused;
  finish?.([{ address: "8.8.8.8", family: 4 }]);
});

it.each([
  ["tool", false],
  ["resource", false],
  ["tool", true],
  ["resource", true],
] as const)(
  "retains an observed %s result when SDK close fails (deadline expired: %s)",
  async (kind, expired) => {
    const fixture = await contractPluginFixture();
    const abort = new AbortController();
    const close = Client.prototype.close;
    const closing = vi.spyOn(Client.prototype, "close").mockImplementation(async function (
      this: Client,
    ) {
      if (expired) abort.abort(new Error("Synthetic operation deadline."));
      await close.call(this);
      throw new Error("Synthetic SDK cleanup failure.");
    });
    try {
      const result = await withPlugin(
        fixture.endpoint,
        fixture.token,
        [fixture.endpoint],
        abort.signal,
        async (client) =>
          kind === "tool"
            ? client.callTool({ name: "read_value", arguments: {} }, undefined, {
                signal: abort.signal,
              })
            : readPluginContent(client, "resource", "notes://public/info", {}, abort.signal),
      );
      expect(result).toEqual(
        kind === "tool"
          ? { content: [{ type: "text", text: "42" }] }
          : {
              contents: [
                { uri: "notes://public/info", mimeType: "text/plain", text: "Untrusted 文档 🧪" },
              ],
            },
      );
      const stats = await fetch(fixture.endpoint.replace("/mcp", "/fixture-control"), {
        method: "POST",
        headers: { Authorization: "Bearer " + fixture.controllerToken },
        body: "{}",
      }).then((response) => response.json());
      expect(stats).toMatchObject({
        toolCalls: kind === "tool" ? 1 : 0,
        resourceReads: kind === "resource" ? 1 : 0,
        deletedSessions: 1,
      });
      expect(closing).toHaveBeenCalledTimes(1);
    } finally {
      closing.mockRestore();
      await fixture.close();
    }
  },
);

it.each(["operation failure", "caller cancellation"])(
  "preserves %s when SDK close also fails",
  async (mode) => {
    const fixture = await contractPluginFixture();
    const abort = new AbortController();
    const original = new Error("Synthetic " + mode);
    const close = Client.prototype.close;
    const closing = vi.spyOn(Client.prototype, "close").mockImplementation(async function (
      this: Client,
    ) {
      await close.call(this);
      throw new Error("Synthetic SDK cleanup failure.");
    });
    if (mode === "caller cancellation") abort.abort(original);
    try {
      await expect(
        withPlugin(fixture.endpoint, fixture.token, [fixture.endpoint], abort.signal, async () => {
          throw original;
        }),
      ).rejects.toBe(original);
    } finally {
      closing.mockRestore();
      await fixture.close();
    }
  },
);
