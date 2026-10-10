/** Disposable browser certificates: the CA key exists only in memory and a dedicated OpenSSL pipe. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";

async function openssl(args: string[], key?: Buffer) {
  const child = spawn("/usr/bin/openssl", args, {
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let count = 0;
  const chunks: Buffer[] = [];
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  const pipe = child.stdio[3] as Writable;
  // A failed command can close the pipe before key delivery; its exit remains mandatory.
  pipe.on("error", () => {});
  pipe.end(key);
  child.stdout!.on("data", (chunk: Buffer) => {
    count += chunk.length;
    if (count <= 64 * 1024) chunks.push(chunk);
    else child.kill("SIGKILL");
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    count += chunk.length;
    if (count > 64 * 1024) child.kill("SIGKILL");
  });
  try {
    assert.equal(await closed, 0, "Fixture certificate command failed");
    assert(count <= 64 * 1024, "Fixture certificate output exceeded");
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    pipe.destroy();
  }
}
export async function prepareNativeTls(directory: string) {
  await mkdir(directory, { mode: 0o700 });
  const save = (name: string, bytes: Buffer | string) =>
    writeFile(join(directory, name), bytes, { flag: "wx", mode: 0o600 });
  await save(
    "ca.cnf",
    "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=OpenBot disposable Linux fixture CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,digitalSignature,keyCertSign,cRLSign\n",
  );
  await save(
    "leaf.cnf",
    "basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:example.com\nextendedKeyUsage=serverAuth\n",
  );
  const caKey = await openssl([
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-pkeyopt",
    "ec_param_enc:named_curve",
  ]);
  try {
    await save(
      "ca.pem",
      await openssl(
        [
          "req",
          "-new",
          "-x509",
          "-key",
          "/dev/fd/3",
          "-sha256",
          "-days",
          "2",
          "-config",
          join(directory, "ca.cnf"),
        ],
        caKey,
      ),
    );
    for (const prefix of ["", "unknown-"]) {
      const leaf = await openssl([
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-pkeyopt",
        "ec_param_enc:named_curve",
      ]);
      try {
        await save(prefix + "key.pem", leaf);
        await save(
          prefix + "request.csr",
          await openssl(["req", "-new", "-key", "/dev/fd/3", "-subj", "/CN=example.com"], leaf),
        );
        const issuer = prefix
          ? ["-signkey", "/dev/fd/3"]
          : ["-CA", join(directory, "ca.pem"), "-CAkey", "/dev/fd/3"];
        await save(
          prefix + "cert.pem",
          await openssl(
            [
              "x509",
              "-req",
              "-in",
              join(directory, prefix + "request.csr"),
              ...issuer,
              "-set_serial",
              "0x" + randomBytes(19).toString("hex"),
              "-sha256",
              "-days",
              "2",
              "-extfile",
              join(directory, "leaf.cnf"),
            ],
            prefix ? leaf : caKey,
          ),
        );
      } finally {
        leaf.fill(0);
      }
    }
  } finally {
    caKey.fill(0);
  }
}
