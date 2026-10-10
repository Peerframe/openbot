/** Verifies Owner file integrity, legacy bytes and the kernel lease across Server processes. */
import { legacy, restoreLegacyFiles } from "../tests/legacy-fixtures.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    it("reads the frozen legacy Owner metadata and exact bytes", async () => {
      const base = mkdtempSync(join(realpathSync(tmpdir()), "openbot-files-legacy-"));
      try {
        restoreLegacyFiles(join(base, "attachments"), legacy.owner.files);
        const store = new OwnerFiles(join(base, "attachments")); store.verify();
        await store.withLock(async (files) => {
          expect(files.metadata(null, legacy.owner.item.id)).toEqual(legacy.owner.item);
          expect(files.content(null, legacy.owner.item.id).data.toString()).toBe("Synthetic legacy attachment");
        });
      } finally { rmSync(base, { recursive: true, force: true }); }
    });
    it("serializes independent Server processes on the same kernel lock", async () => {
      const base = mkdtempSync(join(realpathSync(tmpdir()), "openbot-files-process-")), store = new OwnerFiles(join(base, "attachments"));
      store.verify();
      let child: ReturnType<typeof spawn> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const channel = randomUUID();
        let result: Promise<string> | undefined;
        await store.withLock(async (files) => {
          const item = files.persist(channel, "Shared.txt", Buffer.from("Server original"));
          const module = new URL("../dist/owner-files.js", import.meta.url).href;
          child = spawn(process.execPath, ["--input-type=module", "-e",
            `import {OwnerFiles} from ${JSON.stringify(module)};let raw='';for await(const b of process.stdin)raw+=b;const v=JSON.parse(raw),store=new OwnerFiles(v.root);console.log('waiting');await store.withLock(async files=>{if(files.content(v.channel,v.id).data.toString()!=='Server original')throw Error('bytes changed');console.log(JSON.stringify(files.persist(null,'Replacement.txt',Buffer.from('Replacement original'))));});`,
          ], { stdio: ["pipe", "pipe", "pipe"] });
          const running = child;
          let out = "", err = "", waiting: (() => void) | undefined;
          const ready = new Promise<void>((resolve) => { waiting = resolve; });
          result = new Promise<string>((resolve, reject) => {
            running.stdout!.on("data", (chunk) => { out += chunk; if (out.startsWith("waiting\n")) waiting?.(); });
            running.stderr!.on("data", (chunk) => { err += chunk; });
            running.once("error", reject);
            running.once("exit", (code) => code === 0 ? resolve(out.slice("waiting\n".length)) : reject(new Error(err)));
          });
          void result.catch(() => undefined);
          timer = setTimeout(() => running.kill("SIGKILL"), 8000);
          child.stdin!.end(JSON.stringify({ root: store.root, channel, id: item.id }));
          await Promise.race([ready, result.then(() => { throw new Error("Child exited before locking."); })]);
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(child.exitCode).toBeNull(); expect(out).toBe("waiting\n");
        });
        const value = JSON.parse(await result!);
        await store.withLock(async (files) => { expect(files.content(null, value.id).data.toString()).toBe("Replacement original"); });
        expect(JSON.parse(readFileSync(join(store.root, value.id + ".json"), "utf8")).scopeKind).toBe("owner");
      } finally {
        clearTimeout(timer);
        if (child && child.exitCode === null) { const done = new Promise<void>((resolve) => child!.once("exit", () => resolve())); child.kill("SIGKILL"); await done; }
        rmSync(base, { recursive: true, force: true });
      }
    }, 10000);
  },
);
