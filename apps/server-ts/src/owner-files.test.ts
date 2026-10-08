import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attachmentMedia, attachmentName, OwnerFiles } from "./owner-files.js";

it("preserves filename, signature, UTF-8 and per-media limits", () => {
  expect(attachmentName("资料 ²①.md")).toBe("资料 ²①.md");
  for (const name of ["../file.txt", ".hidden", "file/evil", "x\0.txt", "x😀.txt"])
    expect(() => attachmentName(name)).toThrow();
  expect(attachmentMedia("A.md", Buffer.from("\ufeff中文"))).toBe("text/plain");
  expect(() => attachmentMedia("A.txt", Buffer.from([255]))).toThrow();
  expect(() => attachmentMedia("A.txt", Buffer.alloc(256 * 1024 + 1, 65))).toThrow();
  expect(attachmentMedia("A.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(
    "image/png",
  );
  expect(() => attachmentMedia("A.jpg", Buffer.from("not JPEG"))).toThrow();
});
describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "protected Owner attachment store",
  () => {
    it("roundtrips both namespaces, deletion, recovery markers and immutable-byte integrity", async () => {
      const base = mkdtempSync(join(realpathSync(tmpdir()), "openbot-files-")),
        store = new OwnerFiles(join(base, "attachments")),
        channel = randomUUID();
      store.verify();
      try {
        await store.withLock(async (files) => {
          const item = files.persist(channel, "Text.md", Buffer.from("Scoped file"));
          const owner = files.persist(null, "Owner.txt", Buffer.from("Private file"));
          expect(files.list(channel)).toEqual([item]);
          expect(files.list(null)).toEqual([owner]);
          expect(() => files.metadata(null, item.id)).toThrow();
          expect(() => files.metadata(channel, owner.id)).toThrow();
          expect(files.content(channel, item.id).data.toString()).toBe("Scoped file");
          expect(files.setDeleted(channel, item.id, true).deletedAt).toBeTruthy();
          expect(files.content(channel, item.id).data.toString()).toBe("Scoped file");
          expect(files.setDeleted(channel, item.id, false).deletedAt).toBeUndefined();
          writeFileSync(join(store.root, item.id + ".bin"), "Tampered", { mode: 0o600 });
          expect(() => files.content(channel, item.id)).toThrow();
          files.write(
            item.id + ".purged.json",
            Buffer.from(JSON.stringify({ id: item.id, channelId: channel, purged: true })),
          );
          expect(() => files.metadata(channel, item.id)).toThrowError(
            expect.objectContaining({ status: 410 }),
          );
        });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
    it("refuses an unsafe root and linked bytes, and serializes independently opened locks", async () => {
      const base = mkdtempSync(join(realpathSync(tmpdir()), "openbot-files-lock-")),
        store = new OwnerFiles(join(base, "attachments"));
      store.verify();
      try {
        chmodSync(store.root, 0o755);
        expect(() => store.directory()).toThrow();
        chmodSync(store.root, 0o700);
        await store.withLock(async (files) => {
          const item = files.persist(null, "Test.txt", Buffer.from("safe"));
          const path = join(store.root, item.id + ".bin");
          rmSync(path);
          symlinkSync(join(base, "outside"), path);
          writeFileSync(join(base, "outside"), "private");
          expect(() => files.content(null, item.id)).toThrow();
        });
        const order: string[] = [];
        await Promise.all([
          store.withLock(async () => {
            order.push("first");
            await new Promise((resolve) => setTimeout(resolve, 40));
            order.push("released");
          }),
          store.withLock(async () => {
            order.push("second");
          }),
        ]);
        expect(order).toEqual(["first", "released", "second"]);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
    const root = fileURLToPath(new URL("../../../", import.meta.url)),
      python = join(root, "apps/server-python/.worker-venv/bin/python");
    it.skipIf(!existsSync(python))(
      "interoperates with the retained Python metadata, bytes and kernel lock",
      async () => {
        const base = mkdtempSync(join(realpathSync(tmpdir()), "openbot-files-interop-")),
          store = new OwnerFiles(join(base, "attachments"));
        store.verify();
        let child: ReturnType<typeof spawn> | undefined;
        try {
          const channel = randomUUID();
          let result: Promise<string> | undefined;
          await store.withLock(async (files) => {
            const item = files.persist(channel, "Shared.txt", Buffer.from("TS original"));
            child = spawn(
              python,
              [
                "-I",
                "-B",
                "-c",
                `import sys,json,asyncio
sys.path.insert(0,${JSON.stringify(join(root, "apps/server-python/src"))})
from openbot_server.owner_files import OwnerFiles
v=json.load(sys.stdin)
async def main():
 f=OwnerFiles(v['root'])
 async with f.lock():
  item,data=f.read(v['channel'],v['id'])
  assert data==b'TS original'
  return f.owner_persist('Python.txt',b'Python original')
print(json.dumps(asyncio.run(main())))`,
              ],
              { stdio: ["pipe", "pipe", "pipe"] },
            );
            const running = child;
            let out = "",
              err = "";
            result = new Promise((resolve, reject) => {
              running.stdout!.on("data", (value) => {
                out += value;
              });
              running.stderr!.on("data", (value) => {
                err += value;
              });
              running.once("error", reject);
              running.once("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
            });
            child.stdin!.end(JSON.stringify({ root: store.root, channel, id: item.id }));
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(child.exitCode).toBeNull();
          });
          const value = JSON.parse(await result!);
          await store.withLock(async (files) => {
            expect(files.content(null, value.id).data.toString()).toBe("Python original");
          });
          expect(readFileSync(join(store.root, value.id + ".json"), "utf8")).toContain(
            '"scopeKind": "owner"',
          );
        } finally {
          if (child && child.exitCode === null) child.kill("SIGKILL");
          rmSync(base, { recursive: true, force: true });
        }
      },
      10000,
    );
  },
);
