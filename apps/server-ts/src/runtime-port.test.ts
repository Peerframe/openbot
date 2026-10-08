import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { RuntimePort } from "./runtime-port.js";
import { validateBrowserFrame } from "./product-browser.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(mode: "ok" | "redirect" | "large" | "malformed" | "hold") {
  const seen: { headers: Record<string, unknown>; path: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    seen.push({ headers: req.headers, path: req.url!, body });
    if (mode === "hold") return;
    res.setHeader("Content-Type", "application/json");
    if (mode === "redirect") {
      res.writeHead(302, { Location: "http://127.0.0.1:1/forbidden" });
      res.end("{}");
    } else if (mode === "large") res.end(JSON.stringify({ data: "a".repeat(4 * 1024 * 1024) }));
    else if (mode === "malformed") res.end("{");
    else if (req.url?.endsWith("detach")) res.end('{"detached":true}');
    else
      res.end(
        JSON.stringify({
          nodes: [],
          revision: 0,
          bindings: [],
          browserRoutes: {},
          humanControl: false,
          legacyHumanControl: false,
        }),
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address unavailable.");
  const port = new RuntimePort(
    `http://127.0.0.1:${address.port}`,
    "https://entry.example.test",
    true,
  );
  cleanups.push(async () => port.close());
  return { port, seen };
}
it("forwards only original credential and direct numeric peer to the fixed private operation", async () => {
  const f = await fixture("ok"),
    token = randomBytes(32).toString("base64url");
  const access = f.port.access(token, "127.0.0.2");
  expect((await access.snapshot(AbortSignal.timeout(1000))).nodes).toEqual([]);
  expect(f.seen[0]?.path).toBe("/_openbot/p4/snapshot");
  expect(f.seen[0]?.headers.cookie).toBe("__Host-openbot_session=" + token);
  expect(f.seen[0]?.headers.forwarded).toBe("for=127.0.0.2");
  expect(f.seen[0]?.headers.host).toBe("entry.example.test");
  const enrollment = "obenr_" + randomBytes(32).toString("base64url");
  await f.port
    .access(undefined, "127.0.0.2")
    .detach("test-node", enrollment, AbortSignal.timeout(1000));
  expect(f.seen[1]?.headers.cookie).toBeUndefined();
  expect(JSON.parse(f.seen[1]!.body)).toEqual({ nodeId: "test-node", enrollmentToken: enrollment });
});
it.each(["redirect", "large", "malformed"] as const)(
  "refuses %s runtime responses without retry or successful empty fallback",
  async (mode) => {
    const f = await fixture(mode);
    await expect(
      f.port
        .access(randomBytes(32).toString("base64url"), "127.0.0.1")
        .snapshot(AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.seen).toHaveLength(1);
  },
);
it("caller cancellation and shutdown settle blocked transport", async () => {
  const f = await fixture("hold"),
    abort = new AbortController();
  const pending = f.port
    .access(randomBytes(32).toString("base64url"), "127.0.0.1")
    .snapshot(abort.signal);
  abort.abort();
  await expect(pending).rejects.toMatchObject({ status: 503 });
  const another = f.port
    .access(randomBytes(32).toString("base64url"), "127.0.0.1")
    .snapshot(AbortSignal.timeout(1000));
  f.port.close();
  await expect(another).rejects.toMatchObject({ status: 503 });
});
it("PNG header dimensions and byte bound are checked before a browser frame is disclosed", () => {
  const data = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.writeUInt32BE(1, 16);
  data.writeUInt32BE(2, 20);
  const frame = {
    base64: data.toString("base64"),
    width: 1,
    height: 2,
    url: "",
    capturedAt: new Date().toISOString(),
  };
  expect(validateBrowserFrame(frame)).toEqual(frame);
  expect(() => validateBrowserFrame({ ...frame, height: 3 })).toThrow();
  expect(() => validateBrowserFrame({ ...frame, base64: "AAAAAAAAAAAA" })).toThrow();
});
