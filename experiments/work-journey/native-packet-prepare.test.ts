/** Preserves packet transport, public-only trust and fresh-root boundaries without mutating a host. */
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { connect, createServer } from "node:tls";
import { once } from "node:events";
import {
  browserTrust,
  downloadNative,
  exportArguments,
  packetFiles,
  packetCaptureBytes,
  prepareNativePacket,
  replaceExact,
  SQUID_TAG,
} from "./native-packet-prepare.ts";
import { SubprocessCommander } from "../linux-execution/subprocess.ts";
import { prepareNativeTls } from "./native-packet-tls.ts";
async function root(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "openbot-native-input-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test("source rebinding requires exactly one original reviewed value", () => {
  assert.equal(replaceExact("before old after", "old", "new"), "before new after");
  assert.throws(() => replaceExact("no match", "old", "new"));
  assert.throws(() => replaceExact("old old", "old", "new"));
});
test("OCI export retains registry digest, TLS, no credentials and local Squid content", () => {
  const digest = "sha256:" + "a".repeat(64);
  assert.deepEqual(exportArguments("python:fixture", "/owned/image.tar", digest), [
    "/usr/bin/skopeo",
    "--override-os",
    "linux",
    "--override-arch",
    "amd64",
    "copy",
    "--src-no-creds",
    "--src-tls-verify=true",
    "--preserve-digests",
    "docker://python@" + digest,
    "oci-archive:/owned/image.tar",
  ]);
  const squid = exportArguments(SQUID_TAG, "/owned/squid.tar", undefined, true);
  assert(squid.includes("--dest-oci-accept-uncompressed-layers"));
  assert(!squid.includes("--preserve-digests"));
  assert(squid.includes("docker-daemon:" + SQUID_TAG));
  assert(squid.includes("oci-archive:/owned/squid.tar:" + SQUID_TAG));
});
test("download requires exact bytes and never overwrites a prior packet file", async (t) => {
  const path = join(await root(t), "download"),
    bytes = Buffer.from("synthetic pinned public archive");
  const pin = {
    url: "https://fixture.invalid/archive",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  let calls = 0;
  const fetcher: typeof fetch = async (_url, options) => {
    calls++;
    assert(options?.signal);
    return new Response(bytes);
  };
  await downloadNative(path, pin, fetcher);
  assert.deepEqual(await readFile(path), bytes);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  await assert.rejects(downloadNative(path, pin, fetcher), /EEXIST/);
  assert.equal(calls, 1);
  await assert.rejects(
    downloadNative(path + "-large", { ...pin, size: bytes.length - 1 }, fetcher),
    /exceeded/,
  );
  await assert.rejects(
    downloadNative(path + "-small", { ...pin, size: bytes.length + 1 }, fetcher),
    /size changed/,
  );
  await assert.rejects(
    downloadNative(path + "-hash", { ...pin, sha256: "0".repeat(64) }, fetcher),
    /pin changed/,
  );
  await assert.rejects(
    downloadNative(path + "-http", { ...pin, url: "http://fixture.invalid" }, fetcher),
    /TLS/,
  );
});
test("packet inventory hashes regular files, admits internal links and rejects external links", async (t) => {
  const path = await root(t);
  await mkdir(join(path, "data"));
  await writeFile(join(path, "data/input"), "fixture");
  await symlink("data/input", join(path, "internal"));
  const records = await packetFiles(path);
  assert.deepEqual(
    records.map((v) => v.path),
    ["data/input"],
  );
  assert.equal(records[0]!.sha256, createHash("sha256").update("fixture").digest("hex"));
  await symlink("/etc/passwd", join(path, "external"));
  await assert.rejects(packetFiles(path), /External packet symlink/);
});
test("NSS fixture imports and exposes only the generated public CA", async (t) => {
  const path = await root(t);
  await mkdir(join(path, "tls"));
  await writeFile(join(path, "tls/ca.pem"), "synthetic public certificate");
  const calls: readonly string[][] = [];
  const mutable = calls as string[][];
  await browserTrust(path, "/owned/certutil", async (argv) => {
    mutable.push([...argv]);
    if (argv.includes("-N"))
      for (const name of ["cert9.db", "key4.db"])
        await writeFile(join(path, "nssdb", name), "synthetic NSS database");
    return "";
  });
  assert(calls[1]?.includes(join(path, "tls/ca.pem")));
  assert(calls[1]?.includes("C,,"));
  assert.equal(await readFile(join(path, "nssdb/ca.pem"), "utf8"), "synthetic public certificate");
  assert.equal((await lstat(join(path, "nssdb"))).mode & 0o777, 0o755);
  for (const name of await readdir(join(path, "nssdb")))
    assert.equal((await lstat(join(path, "nssdb", name))).mode & 0o777, 0o644);
  await assert.rejects(
    browserTrust(path, "/owned/certutil", async () => ""),
    /EEXIST/,
  );
});
test("packet preparation rejects an ordinary host before selecting paths or writing", async () => {
  await assert.rejects(
    prepareNativePacket("/unused", "/unused", "/unused", "/unused", "/unused"),
    /Disposable Linux CI only/,
  );
});
test("real OpenSSL browser fixture verifies trusted TLS and rejects hostname and unknown CA", {
  timeout: 30000,
}, async (t) => {
  const path = join(await root(t), "tls");
  await prepareNativeTls(path);
  const names = await readdir(path);
  assert(!names.includes("ca.key"));
  const ca = await readFile(join(path, "ca.pem")),
    cert = await readFile(join(path, "cert.pem")),
    unknown = await readFile(join(path, "unknown-cert.pem"));
  const authority = new X509Certificate(ca),
    trusted = new X509Certificate(cert),
    untrusted = new X509Certificate(unknown);
  assert(authority.ca);
  assert(!trusted.ca);
  assert.equal(trusted.publicKey.asymmetricKeyType, "ec");
  assert.equal(trusted.checkHost("example.com"), "example.com");
  assert.equal(trusted.checkHost("wrong.example"), undefined);
  assert(trusted.verify(authority.publicKey));
  assert(!untrusted.verify(authority.publicKey));
  for (const name of names) {
    const content = await readFile(join(path, name), "utf8");
    if (content.includes("PRIVATE KEY")) assert(["key.pem", "unknown-key.pem"].includes(name));
    assert.equal((await lstat(join(path, name))).mode & 0o777, 0o600);
  }
  for (const prefix of ["", "unknown-"]) {
    const server = createServer(
      {
        cert: await readFile(join(path, prefix + "cert.pem")),
        key: await readFile(join(path, prefix + "key.pem")),
        minVersion: "TLSv1.2",
      },
      (socket) => socket.end("fixture"),
    );
    server.on("tlsClientError", () => {});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert(address && typeof address === "object");
      const handshake = async (servername: string) => {
        const socket = connect({
          host: "127.0.0.1",
          port: address.port,
          servername,
          ca,
          rejectUnauthorized: true,
        });
        try {
          await once(socket, "secureConnect");
          assert(socket.authorized);
        } finally {
          socket.destroy();
        }
      };
      if (prefix) await assert.rejects(handshake("example.com"), /self.signed|certificate/i);
      else {
        await handshake("example.com");
        await assert.rejects(handshake("wrong.example"), /Hostname|altname|not in the cert/i);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  await assert.rejects(prepareNativeTls(path), /EEXIST/);
});

test("packet image/build capture fits the existing bounded commander", async () => {
  const command = new SubprocessCommander({
    binary: process.execPath,
    captureLimit: packetCaptureBytes,
  });
  const result = await command.run(["-e", "process.stdout.write('fixture transport ready')"], 3000);
  assert(result.ok);
  assert.equal(result.stdout, "fixture transport ready");
  const overflow = await command.run(
    ["-e", `process.stdout.write("x".repeat(${packetCaptureBytes + 1}))`],
    3000,
  );
  assert(!overflow.ok && overflow.outputTruncated && overflow.uncertain);
});

test("multi-platform registry index remains distinct from the selected OCI manifest", () => {
  const index = "sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e";
  const platform = "sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac";
  const args = exportArguments(
    "mcr.microsoft.com/playwright:v1.62.1-noble@" + index,
    "/owned/browser.tar",
    platform,
  );
  assert(args.includes("docker://mcr.microsoft.com/playwright@" + index));
  assert(!args.some((value) => value.includes(platform)));
});
