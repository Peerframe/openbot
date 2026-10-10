/** Real Server scenario; synthetic rows and peers are restricted to its owned fixture. */
import { scenarioStep as check } from "./scenario-step.ts";
import { strToU8, zipSync } from "fflate";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase } from "@openbot/db";
import { OwnerFiles } from "../../apps/server/dist/owner-files.js";
import { PurgeFiles } from "../../apps/server/dist/attachment-purge-files.js";

export async function qualifyFileOwnership(options: {
  databaseUrl: string;
  origin: string;
  cookie: string;
  restart(): Promise<void>;
  objectRoot: string;
}) {
  const sql = createDatabase(options.databaseUrl).client,
    channel = randomUUID(),
    root = join(options.objectRoot, "attachments"),
    store = new OwnerFiles(root);
  const base = `/api/v1/channels/${channel}/attachments`,
    owned: string[] = [];
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
    cookie = options.cookie,
  ) => {
    const response = await fetch(options.origin + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(method !== "GET" ? { Origin: options.origin } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(path.endsWith("/process") ? 65000 : 10000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      body: response.headers.get("content-type")?.includes("application/json")
        ? JSON.parse(bytes.toString())
        : bytes,
      headers: response.headers,
    };
  };
  const upload = async (
    scope: string,
    name = "Fixture.txt",
    bytes = Buffer.from("Synthetic immutable file"),
  ) => {
    const result = await call(scope, "POST", bytes, {
      "Content-Type": "application/octet-stream",
      "X-OpenBot-Filename": encodeURIComponent(name),
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    owned.push(result.body.attachment.id);
    return result.body.attachment as {
      id: string;
      name: string;
      sha256: string;
      channelId: string;
    };
  };
  const deleteItem = async (id: string) =>
    assert.equal((await call(base + "/" + id, "DELETE")).status, 200);
  try {
    await sql`INSERT INTO channels(id,name,description) VALUES(${channel},'Synthetic file ownership','No production data')`;

    await check("authentication precedes raw upload and storage input validation", async () => {
      assert.equal((await call(base, "POST", {}, {}, "")).status, 401);
      assert.equal(
        (await call("/api/v1/storage?unexpected=1", "GET", undefined, {}, "")).status,
        401,
      );
      assert.equal((await call(base, "POST", {})).status, 415);
      const before = await call("/api/v1/settings/storage");
      const raw = Buffer.from(
        `{"expectedRevision":${before.body.revision}.0,"trashAutoPurgeDays":null}`,
      );
      assert.equal((await call("/api/v1/settings/storage", "PUT", raw)).status, 422);
      assert.deepEqual((await call("/api/v1/settings/storage")).body, before.body);
    });
    const item = await upload(base, "中文 file.txt");
    const owner = await upload("/api/v1/task-attachments", "Owner.txt");
    await check(
      "scoped files and settings stay available with a restarted Server and survive explicit reverse",
      async () => {
        const snapshot = async () =>
          Promise.all([
            call(base + "/" + item.id),
            call(base + "/" + item.id + "/content"),
            call("/api/v1/task-attachments/" + owner.id),
            call("/api/v1/settings/storage"),
          ]).then((values) => values.map((value) => ({ status: value.status, body: value.body })));
        const before = await snapshot();
        assert(before.every((value) => value.status === 200));
        await options.restart();
        try {
          assert.deepEqual(await snapshot(), before);
        } finally {
          await options.restart();
        }
        await options.restart();
        try {
          assert.deepEqual(await snapshot(), before);
        } finally {
          await options.restart();
        }
        assert.equal((await call("/api/v1/task-attachments/" + item.id)).status, 404);
        assert.equal((await call(base + "/" + owner.id)).status, 404);
      },
    );
    await check(
      "actual Node parsers process both namespaces after Server restart and preserve original bytes",
      async () => {
        const original = Buffer.from(
          zipSync({
            "[Content_Types].xml": strToU8(
              '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
            ),
            "word/document.xml": strToU8(
              '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>OpenBot HTTP processing evidence</w:t></w:r></w:p></w:body></w:document>',
            ),
          }),
        );
        const items = await Promise.all([
          upload(base, "Evidence.docx", original),
          upload("/api/v1/task-attachments", "Evidence.docx", original),
        ]);
        const paths = [base, "/api/v1/task-attachments"];
        await options.restart();
        try {
          for (const [index, file] of items.entries()) {
            const response = await call(paths[index] + "/" + file.id + "/process", "POST", {
              operation: "extract",
            });
            assert.equal(response.status, 200, JSON.stringify(response.body));
            assert.equal(response.body.attachment.processing.operation, "extract");
            const derived = JSON.parse(await readFile(join(root, file.id + ".text.json"), "utf8"));
            assert(derived.text.includes("OpenBot HTTP processing evidence"));
            assert.equal(derived.sha256, file.sha256);
            assert.deepEqual(
              (await call(paths[index] + "/" + file.id + "/content")).body,
              original,
            );
            assert.equal(
              (
                await call(paths[index] + "/" + file.id + "/process", "POST", {
                  operation: "transcribe",
                })
              ).status,
              415,
            );
          }
          const fixture = fileURLToPath(
            new URL(
              "../../tests/oracles/legacy-server/src/__fixtures__/attachments/encrypted.pdf",
              import.meta.url,
            ),
          );
          const pdf = await upload(base, "Encrypted.pdf", await readFile(fixture));
          const refused = await call(base + "/" + pdf.id + "/process", "POST", {
            operation: "extract",
            password: "incorrect",
          });
          assert.equal(refused.status, 400);
          assert.deepEqual(refused.body, { error: "pdf_password_required" });
          assert.equal(
            (
              await call(base + "/" + pdf.id + "/process", "POST", {
                operation: "extract",
                password: "openbot-test-password",
              })
            ).status,
            200,
          );
          assert(!(await readFile(join(root, pdf.id + ".json"), "utf8")).includes("password"));
        } finally {
          await options.restart();
        }
        await options.restart();
        try {
          for (const [index, file] of items.entries()) {
            const response = await call(paths[index] + "/" + file.id);
            assert.equal(response.status, 200);
            assert.equal(response.body.attachment.processing.operation, "extract");
          }
        } finally {
          await options.restart();
        }
      },
    );
    await check(
      "corrupt/linked bytes and float metadata fail without reading external files",
      async () => {
        const file = await upload(base),
          path = join(root, file.id + ".bin"),
          original = await readFile(path);
        await writeFile(path, "tampered");
        assert.equal((await call(base + "/" + file.id + "/content")).status, 404);
        await rm(path);
        await symlink(join(root, owner.id + ".bin"), path);
        assert.equal((await call(base + "/" + file.id + "/content")).status, 404);
        await rm(path);
        await writeFile(path, original, { mode: 0o600 });
        const metadataPath = join(root, file.id + ".json"),
          metadata = await readFile(metadataPath, "utf8");
        await writeFile(metadataPath, metadata.replace(/"sizeBytes":([0-9]+)/, '"sizeBytes":$1.0'));
        assert.equal((await call(base + "/" + file.id)).status, 404);
        await writeFile(metadataPath, metadata);
        assert.equal((await call(base + "/" + file.id + "/content")).status, 200);
      },
    );
    await check("failed SQL purge receipt restores exact staged bytes and metadata", async () => {
      const file = await upload(base);
      await deleteItem(file.id);
      const before = await readFile(join(root, file.id + ".json")),
        bytes = await readFile(join(root, file.id + ".bin"));
      await sql`ALTER TABLE attachment_purges ADD CONSTRAINT ts_file_receipt_fault CHECK(false) NOT VALID`;
      try {
        assert.equal((await call(base + "/" + file.id + "/purge", "DELETE", {})).status, 503);
      } finally {
        await sql`ALTER TABLE attachment_purges DROP CONSTRAINT ts_file_receipt_fault`;
      }
      assert.deepEqual(await readFile(join(root, file.id + ".json")), before);
      assert.deepEqual(await readFile(join(root, file.id + ".bin")), bytes);
      assert.equal((await call(base + "/" + file.id + "/content")).status, 200);
    });
    await check(
      "a concurrent committed reference blocks purge after staging without losing bytes",
      async () => {
        const file = await upload(base);
        await deleteItem(file.id);
        const message = randomUUID();
        let inserted!: () => void, release!: () => void;
        const ready = new Promise<void>((resolve) => {
            inserted = resolve;
          }),
          unlock = new Promise<void>((resolve) => {
            release = resolve;
          });
        const writer = sql.begin(async (db) => {
          await db`INSERT INTO messages(id,channel_id,author_type,content) VALUES(${message},${channel},'human',${"[openbot attachment: " + file.id + "]"})`;
          inserted();
          await unlock;
        });
        try {
          await ready;
          const request = call(base + "/" + file.id + "/purge", "DELETE", {});
          const deadline = Date.now() + 700;
          while (!(await readdir(root)).some((name) => name.startsWith(".purge-"))) {
            assert(Date.now() < deadline, "purge did not reach staged reference gate");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          release();
          await writer;
          const response = await request;
          assert.equal(response.status, 409);
          assert.deepEqual(response.body.referenceCount, { messages: 1, tasks: 0 });
          assert.equal((await call(base + "/" + file.id + "/content")).status, 200);
        } finally {
          release();
          await writer;
          await sql`DELETE FROM messages WHERE id=${message}`;
        }
      },
    );
    await check(
      "recovery uses actual SQL receipts after both committed and uncommitted staging",
      async () => {
        const restored = await upload(base),
          removed = await upload(base);
        await deleteItem(removed.id);
        await store.withLock(async (session) => {
          const journal = new PurgeFiles(session),
            operation = journal.stage([
              session.metadata(channel, restored.id),
              session.metadata(channel, removed.id),
            ]);
          await sql`INSERT INTO attachment_purges(id,channel_id,operation_id,freed_bytes) VALUES(${removed.id},${channel},${operation},1)`;
        });
        assert.equal((await call(base + "/" + restored.id + "/content")).status, 200);
        const gone = await call(base + "/" + removed.id);
        assert.equal(gone.status, 410);
        assert.equal(gone.body.purged, true);
        await store.withLock(async (session) =>
          assert.deepEqual(new PurgeFiles(session).journals(), []),
        );
      },
    );
    await check(
      "default-off maintenance claims once and purges aged unreferenced trash after Server restart",
      async () => {
        const file = await upload(base);
        await deleteItem(file.id);
        await store.withLock(async (session) => {
          const item = session.metadata(channel, file.id);
          item.deletedAt = "2000-01-01T00:00:00.000Z";
          session.write(file.id + ".json", Buffer.from(JSON.stringify(item)));
        });
        const before = await call("/api/v1/settings/storage");
        assert.equal(before.body.trashAutoPurgeDays, null);
        await options.restart();
        try {
          const saved = await call("/api/v1/settings/storage", "PUT", {
            expectedRevision: before.body.revision,
            trashAutoPurgeDays: 30,
          });
          assert.equal(saved.status, 200);
          const deadline = Date.now() + 8000;
          for (;;) {
            const [receipt] =
              await sql`SELECT operation_id FROM attachment_purges WHERE id=${file.id}`;
            if (receipt) break;
            assert(Date.now() < deadline, "TS maintenance did not commit a purge receipt");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.equal((await call(base + "/" + file.id)).status, 410);
          const [finished] =
            await sql`SELECT count(*)::integer AS n FROM run_events WHERE type='SETTINGS_TRASH_AUTO_PURGE_RUN' AND payload->>'outcome'='completed'`;
          assert.equal(finished!.n, 1);
          const current = await call("/api/v1/settings/storage");
          assert.equal(
            (
              await call("/api/v1/settings/storage", "PUT", {
                expectedRevision: current.body.revision,
                trashAutoPurgeDays: null,
              })
            ).status,
            200,
          );
        } finally {
          await options.restart();
        }
      },
    );

  } finally {
    // All fixtures live in this disposable database/root; cleanup does not touch user files.
    await sql`DELETE FROM run_events WHERE channel_id=${channel}`;
    await sql`DELETE FROM attachment_purges WHERE channel_id=${channel}`;
    await sql`DELETE FROM channels WHERE id=${channel}`;
    for (const id of owned)
      for (const suffix of [".json", ".bin", ".text.json", ".purged.json"])
        await rm(join(root, id + suffix), { force: true });
    await sql.end({ timeout: 1 });
  }
}
