/** Synthetic HTTPS and parser checks run only inside the disposable product container. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { crc32, deflateSync } from "node:zlib";
const require = createRequire("/workspace/package.json");
const { zipSync, strToU8 } = require("fflate");
const { NodeAttachmentParser } = await import("/workspace/apps/server/dist/attachment-parser.js");
const phase = process.argv[1]; assert(["create", "restart"].includes(phase));
const origin = new URL(process.env.OPENBOT_TS_PUBLIC_ORIGIN);
const ca = await readFile(process.env.OPENBOT_TS_HEALTH_CA_PATH);
let cookie = "";
async function request(path, body, { raw = false, headers = {}, status = 200 } = {}) {
  const bytes = body === undefined ? undefined : raw ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: "127.0.0.1", port: 3001, servername: origin.hostname, ca, path,
      method: body === undefined ? "GET" : "POST", timeout: 70000,
      headers: { Host: origin.host, Origin: origin.origin, Cookie: cookie, ...(body === undefined || raw ? {} : { "Content-Type": "application/json" }), ...headers },
    }, (res) => {
      const parts = []; let size = 0;
      res.on("error", reject); res.on("data", (part) => { size += part.length; if (size > 2 * 1024 * 1024) res.destroy(new Error("Smoke response limit")); else parts.push(part); });
      res.on("end", () => { try { assert.equal(res.statusCode, status, `unexpected_http_status:${path}`); resolve({ bytes: Buffer.concat(parts), headers: res.headers }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Smoke deadline"))); req.end(bytes);
  });
}
const json = async (...args) => JSON.parse((await request(...args)).bytes.toString());
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.equal((await json("/health")).phase, "typescript-product-candidate");
assert.match((await request("/")).bytes.toString(), /<html/i);
const login = await request("/api/v1/auth/login", { password: process.env.OPENBOT_TS_OWNER_PASSWORD });
cookie = login.headers["set-cookie"][0].split(";")[0]; assert(cookie.startsWith("__Host-openbot_session="));
assert.deepEqual((await json("/api/v1/nodes")).nodes, []);
await request("/api/v1/settings/model", undefined, { status: 404 });
assert.deepEqual((await json("/api/v1/model-services")).connections, []);
assert.equal((await json("/api/v1/settings/transcription")).connectionId, null);
const keyPath = "/var/lib/openbot/objects/model-connections.key", record = "/var/lib/openbot/smoke-record.json";
const key = await readFile(keyPath); assert.equal(key.length, 32); assert.equal((await stat(keyPath)).mode & 0o077, 0);
const keyHash = hash(key);
if (phase === "create") {
  const channel = (await json("/api/v1/channels", { name: "Synthetic container lifecycle", botIds: [] }, { status: 201 })).channel;
  const docx = Buffer.from(zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>OpenBot container evidence</w:t></w:r></w:p></w:body></w:document>'),
  }));
  const text = "BT /F1 18 Tf 30 100 Td (OpenBot container evidence) Tj ET";
  const objects = ['<</Type /Catalog /Pages 2 0 R>>', '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>>',
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>', `<</Length ${text.length}>>\nstream\n${text}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(pdf);
  pdf += "xref\n0 6\n0000000000 65535 f \n" + offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") + `trailer <</Size 6 /Root 1 0 R>>\nstartxref\n${start}\n%%EOF\n`;
  const attachments = [];
  for (const [extension, data] of [["docx", docx], ["pdf", Buffer.from(pdf)]]) {
    const path = `/api/v1/channels/${channel.id}/attachments`;
    const item = (await json(path, data, { raw: true, headers: { "Content-Type": "application/octet-stream", "X-OpenBot-Filename": `synthetic.${extension}` }, status: 201 })).attachment;
    const processed = (await json(`${path}/${item.id}/process`, { operation: "extract" })).attachment;
    assert(processed.processing.characters >= 25); assert.equal(processed.processing.truncated, false);
    attachments.push({ id: item.id, sha256: hash(data) });
  }
  await writeFile(record, JSON.stringify({ channel: channel.id, attachments, keyHash }), { mode: 0o600, flag: "wx" });
  const chunk = (kind, data) => { const name = Buffer.from(kind), header = Buffer.alloc(4), checksum = Buffer.alloc(4); header.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([header, name, data, checksum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(100, 0); ihdr.writeUInt32BE(100, 4); ihdr[8] = 8;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(100, 255)]);
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 100 }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
  const parser = new NodeAttachmentParser("/workspace/apps/server/dist/parser-worker.js", "/workspace/node_modules");
  assert.deepEqual(await parser.parse(png, "png", { operation: "ocr" }, AbortSignal.timeout(70000)), { text: "", truncated: false });
} else {
  const saved = JSON.parse(await readFile(record, "utf8")); assert.equal(keyHash, saved.keyHash);
  assert((await json("/api/v1/channels")).channels.some((v) => v.id === saved.channel));
  for (const item of saved.attachments) {
    const path = `/api/v1/channels/${saved.channel}/attachments/${item.id}`;
    assert((await json(path)).attachment.processing.characters >= 25);
    assert.equal(hash((await request(path + "/content")).bytes), item.sha256);
  }
}
console.log(JSON.stringify({ phase, ownerHttp: true, builtWeb: true, persistentKeyAndFiles: true, parsers: phase === "create" ? ["docx", "pdf", "ocr-blank-initialization"] : [] }));
