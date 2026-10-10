/** Retains protected one-shot records, no-follow reads, strict frames and bounded EOF behavior. */
import assert from "node:assert/strict";
import { chmod, link, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  directory,
  digest,
  exclusive,
  readBytes,
  readRecord,
  receive,
  send,
} from "./protected-io.ts";
async function fixture(t: { after: (f: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "openbot-protected-io-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("exclusive durable records cannot be replaced or retried", async (t) => {
  const path = join(await fixture(t), "record.json");
  exclusive(path, { accepted: true, sequence: 1 });
  assert.deepEqual(readRecord(path, process.getuid!()), { accepted: true, sequence: 1 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.throws(() => exclusive(path, { accepted: false }), { code: "EEXIST" });
  assert.equal(digest(path), "e3bdf17c539f2304caf10337cb04837ea0b7024f6c9948b24cc57ac621506427");
});
test("private reads reject links, writable modes, oversize, duplicate keys and directory aliases", async (t) => {
  const root = await fixture(t),
    path = join(root, "key");
  await writeFile(path, "secret", { mode: 0o600 });
  assert.equal(readBytes(path, 8, { uid: process.getuid!() }).toString(), "secret");
  assert.throws(() => readBytes(path, 5, { uid: process.getuid!() }), /oversized/);
  const linked = join(root, "linked");
  await symlink(path, linked);
  assert.throws(() => readBytes(linked, 8, { uid: process.getuid!() }));
  await link(path, join(root, "hard"));
  assert.throws(() => readBytes(path, 8, { uid: process.getuid!() }), /unsafe_file/);
  await rm(join(root, "hard"));
  await chmod(path, 0o666);
  assert.throws(() => readBytes(path, 8, { uid: process.getuid!() }), /unsafe_file/);
  await chmod(path, 0o600);
  await writeFile(path, '{"x":1,"x":2}');
  assert.throws(() => readRecord(path, process.getuid!()), /invalid_command/);
  const alias = join(root, "alias");
  await symlink(root, alias);
  assert.throws(() => directory(alias, process.getuid!()), /unsafe_path/);
});
async function pair(t: { after: (f: () => Promise<void>) => void }) {
  const root = await fixture(t),
    server = createServer(),
    path = join(root, "s");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve)),
    client = connect(path);
  const peer = await accepted;
  t.after(async () => {
    client.destroy();
    peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { client, peer };
}
test("actual split Unix frames preserve exact values and sequential responses", async (t) => {
  const { client, peer } = await pair(t),
    values: unknown[] = [];
  const done = (async () => {
    for await (const value of receive(peer)) values.push(value);
  })();
  await send(client, { value: "事实", integer: 1 });
  await send(client, { next: true });
  client.end();
  await done;
  assert.deepEqual(values, [{ value: "事实", integer: 1 }, { next: true }]);
});
for (const [name, body, length] of [
  ["duplicate", '{"x":1,"x":2}', undefined],
  ["float", '{"x":1.0}', undefined],
  ["oversize", "", 32769],
  ["empty", "", 0],
  ["partial", '{"x":1}', 20],
] as const)
  test("strict framing rejects " + name, async (t) => {
    const { client, peer } = await pair(t);
    const checked = (async () => {
      for await (const _ of receive(peer)) assert.fail("Invalid frame delivered.");
    })();
    const bytes = Buffer.from(body),
      frame = Buffer.alloc(4 + bytes.length);
    frame.writeUInt32BE(length ?? bytes.length);
    bytes.copy(frame, 4);
    client.end(frame);
    await assert.rejects(checked, /invalid_command|oversized_frame|partial_frame/);
  });
