import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
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
import { PurgeFiles } from "./attachment-purge-files.js";
import { OwnerFiles } from "./owner-files.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url)),
  python = join(repository, "apps/server-python/.worker-venv/bin/python");
function fixture() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "openbot-purge-")),
    store = new OwnerFiles(join(base, "attachments"));
  store.verify();
  return { base, store, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
describe.skipIf(!["darwin", "linux"].includes(process.platform))("recoverable file purge", () => {
  it("restores uncommitted entries and removes only SQL-confirmed identities", async () => {
    const { store, cleanup } = fixture();
    try {
      await store.withLock(async (files) => {
        const channel = randomUUID(),
          retained = files.persist(channel, "Retained.txt", Buffer.from("still referenced")),
          removed = files.persist(channel, "Removed.txt", Buffer.from("expired"));
        const journal = new PurgeFiles(files),
          operation = journal.stage([retained, removed]),
          name = ".purge-" + operation;
        expect(() => files.content(channel, retained.id)).toThrow();
        const value = journal.read(name);
        expect(journal.stagedBytes(name, value.entries[0]!)).toBeGreaterThan(retained.sizeBytes);
        journal.resolve(name, value, new Set([removed.id]));
        expect(files.content(channel, retained.id).data.toString()).toBe("still referenced");
        expect(() => files.metadata(channel, removed.id)).toThrowError(
          expect.objectContaining({ status: 410 }),
        );
        expect(journal.journals()).toEqual([]);
        expect(existsSync(join(store.root, removed.id + ".bin"))).toBe(false);
      });
    } finally {
      cleanup();
    }
  });
  it("refuses conflicting destinations before restoring any entry and refuses linked staged files", async () => {
    const { store, cleanup, base } = fixture();
    try {
      await store.withLock(async (files) => {
        const channel = randomUUID(),
          a = files.persist(channel, "First.txt", Buffer.from("original first")),
          b = files.persist(channel, "Second.txt", Buffer.from("original second")),
          journal = new PurgeFiles(files);
        const name = ".purge-" + journal.stage([a, b]),
          value = journal.read(name);
        writeFileSync(join(store.root, b.id + ".bin"), "concurrent unrelated", { mode: 0o600 });
        expect(() => journal.resolve(name, value, new Set())).toThrowError(
          expect.objectContaining({ body: { error: "purge_recovery_conflict" } }),
        );
        expect(existsSync(join(store.root, a.id + ".bin"))).toBe(false);
        expect(readFileSync(join(store.root, b.id + ".bin"), "utf8")).toBe("concurrent unrelated");
        rmSync(join(store.root, b.id + ".bin"));
        const staged = join(store.root, name, a.id + ".bin");
        rmSync(staged);
        writeFileSync(join(base, "outside"), "private", { mode: 0o600 });
        symlinkSync(join(base, "outside"), staged);
        expect(() => journal.resolve(name, value, new Set([a.id]))).toThrow();
        expect(readFileSync(join(base, "outside"), "utf8")).toBe("private");
      });
    } finally {
      cleanup();
    }
  });
  it.skipIf(!existsSync(python))(
    "recovers Python staging in TS and TS staging in Python with the same durable format",
    async () => {
      const { store, cleanup } = fixture();
      const run = (code: string, input: unknown) =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(
            python,
            [
              "-I",
              "-B",
              "-c",
              `import sys,json,asyncio\nsys.path.insert(0,${JSON.stringify(join(repository, "apps/server-python/src"))})\n` +
                code,
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          let out = "",
            err = "";
          child.stdout.on("data", (value) => {
            out += value;
          });
          child.stderr.on("data", (value) => {
            err += value;
          });
          child.once("error", reject);
          child.once("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
          child.stdin.end(JSON.stringify(input));
        });
      const channel = randomUUID();
      try {
        const item = JSON.parse(
          await run(
            `from openbot_server.owner_files import OwnerFiles
from openbot_server.attachment_purge_files import PurgeFiles
v=json.load(sys.stdin)
async def main():
 f=OwnerFiles(v['root'])
 async with f.lock():
  item=f.persist(v['channel'],'Python.txt',b'Python staged bytes')
  PurgeFiles(f).stage([item])
  print(json.dumps(item))
asyncio.run(main())`,
            { root: store.root, channel },
          ),
        );
        await store.withLock(async (files) => {
          const journal = new PurgeFiles(files),
            name = journal.journals()[0]!;
          journal.resolve(name, journal.read(name), new Set());
          expect(files.content(channel, item.id).data.toString()).toBe("Python staged bytes");
          journal.stage([files.metadata(channel, item.id)]);
        });
        await run(
          `from openbot_server.owner_files import OwnerFiles
from openbot_server.attachment_purge_files import PurgeFiles
v=json.load(sys.stdin)
async def main():
 f=OwnerFiles(v['root'])
 async with f.lock():
  j=PurgeFiles(f)
  for name in j.journals(): j.resolve(name,j.read_journal(name),{v['id']})
asyncio.run(main())`,
          { root: store.root, id: item.id },
        );
        await store.withLock(async (files) => {
          expect(() => files.metadata(channel, item.id)).toThrowError(
            expect.objectContaining({ status: 410 }),
          );
          expect(new PurgeFiles(files).journals()).toEqual([]);
        });
      } finally {
        cleanup();
      }
    },
    10000,
  );
});
