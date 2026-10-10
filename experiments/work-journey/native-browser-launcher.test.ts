/** Actual sockets and bounded acceptance streams exercise the root-launcher protocol without root. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { launchNativeBrowser, productAcceptance } from "./native-browser-launcher.ts";
import { openNativeRelay } from "./native-browser-relay.ts";

for (const accepted of [true, false])
  test(`one bounded product acceptance ${accepted}`, async () => {
    const input = new PassThrough(),
      result = productAcceptance(input);
    input.write('{"product');
    input.end('Accepted":' + accepted + "}\n");
    assert.equal(await result, accepted);
    assert(input.destroyed);
  });
for (const [name, value] of [
  ["extra key", '{"productAccepted":true,"other":1}\n'],
  ["coercible flag", '{"productAccepted":"true"}\n'],
  ["duplicate key", '{"productAccepted":true,"productAccepted":false}\n'],
  ["missing newline", '{"productAccepted":true}'],
  ["extra line", '{"productAccepted":true}\n{}\n'],
  ["oversized line", " ".repeat(1025)],
  ["empty EOF", ""],
])
  test(`acceptance refuses ${name}`, async () => {
    const input = Readable.from([Buffer.from(value!)]);
    await assert.rejects(productAcceptance(input));
    assert(input.destroyed);
  });
test("root launcher rejects an ordinary host before packet mutation", async () => {
  await assert.rejects(launchNativeBrowser(), /Root CI packet required/);
});
const unix = process.platform === "win32" ? "Owned Unix relay CI fixture is Unix-only" : false;
test("loopback relay transfers split bidirectional bytes and closes every owned socket", {
  skip: unix,
  timeout: 10000,
}, async (t) => {
  const root = await mkdtemp("/private/tmp/openbot-relay-").catch(async () => {
    await mkdir("/tmp", { recursive: true });
    return mkdtemp("/tmp/openbot-relay-");
  });
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "owned.sock"),
    input: Buffer[] = [];
  const target = createServer((socket) =>
    socket.on("data", (bytes) => {
      input.push(Buffer.from(bytes));
      socket.write(bytes);
    }),
  );
  target.listen(path);
  await once(target, "listening");
  const relay = await openNativeRelay({ host: "127.0.0.1", port: 0 }, { path });
  try {
    const address = relay.address();
    assert(typeof address === "object");
    const client = createConnection({ host: "127.0.0.1", port: address.port });
    client.on("error", () => {});
    const received: Buffer[] = [];
    client.on("data", (bytes) => received.push(Buffer.from(bytes)));
    // Submit before connect to exercise buffered eager HTTP input.
    client.write("first-");
    client.write("second");
    const end = performance.now() + 3000;
    while (Buffer.concat(received).length < 12 && performance.now() < end) await delay(5);
    assert.equal(Buffer.concat(received).toString(), "first-second");
    assert.equal(Buffer.concat(input).toString(), "first-second");
    const closed = once(client, "close");
    await relay.close();
    await closed;
    assert(client.destroyed);
  } finally {
    if (relay.server.listening) await relay.close();
    await new Promise<void>((resolve, reject) =>
      target.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test("relay bounds the aggregate stream and refuses a missing target", {
  timeout: 10000,
}, async () => {
  let received = 0;
  const target = createServer((socket) => {
    socket.on("error", () => {});
    socket.on("data", (bytes) => {
      received += bytes.length;
    });
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const address = target.address();
  assert(address && typeof address === "object");
  const relay = await openNativeRelay(
    { host: "127.0.0.1", port: 0 },
    { host: "127.0.0.1", port: address.port },
  );
  try {
    const local = relay.address();
    assert(typeof local === "object");
    const client = createConnection({ host: "127.0.0.1", port: local.port });
    client.on("error", () => {});
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    client.write(Buffer.alloc(3 * 1024 * 1024));
    await closed;
    assert(received <= 2 * 1024 * 1024);
  } finally {
    await relay.close();
    await new Promise<void>((resolve, reject) =>
      target.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const missing = await openNativeRelay(
    { host: "127.0.0.1", port: 0 },
    { host: "127.0.0.1", port: address.port },
  );
  try {
    const local = missing.address();
    assert(typeof local === "object");
    const client = createConnection({ host: "127.0.0.1", port: local.port });
    client.on("error", () => {});
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
    assert(client.destroyed);
  } finally {
    await missing.close();
  }
});
