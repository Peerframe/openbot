import { createPrivateKey, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { createSecureContext, type TlsOptions } from "node:tls";
import type { EntryOptions } from "./config.js";

async function readOperatorFile(path: string, limit: number, privateKey: boolean) {
  // Canonical paths and a non-following fd keep directory/leaf symlinks out of this boundary.
  if (!process.getuid || (await realpath(path)) !== resolve(path)) throw new Error();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > limit ||
      (privateKey ? (stat.mode & 0o777) !== 0o600 : (stat.mode & 0o022) !== 0)
    )
      throw new Error();
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length < 1 || length > limit) throw new Error();
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** TLS terminates here; neither public headers nor Python can choose this key or TLS policy. */
export async function entryTls(options: EntryOptions): Promise<TlsOptions | undefined> {
  if (!options.tls) return undefined;
  try {
    const cert = await readOperatorFile(options.tls.certificatePath, 65536, false);
    const key = await readOperatorFile(options.tls.privateKeyPath, 16384, true);
    const leaf = new X509Certificate(cert);
    const hostname = new URL(options.publicOrigin).hostname.replace(/^\[|\]$/gu, "");
    const now = Date.now();
    const validFrom = Date.parse(leaf.validFrom);
    const validTo = Date.parse(leaf.validTo);
    // An absent EKU permits any use; a restricted certificate must permit TLS server authentication.
    const serverPurpose =
      !leaf.keyUsage ||
      leaf.keyUsage.includes("1.3.6.1.5.5.7.3.1") ||
      leaf.keyUsage.includes("2.5.29.37.0");
    if (
      leaf.ca ||
      !serverPurpose ||
      !leaf.checkPrivateKey(createPrivateKey(key)) ||
      !Number.isFinite(validFrom) ||
      !Number.isFinite(validTo) ||
      now < validFrom ||
      now >= validTo ||
      !(isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname, { subject: "never" }))
    )
      throw new Error();
    const tls: TlsOptions = {
      cert,
      key,
      minVersion: "TLSv1.2",
      handshakeTimeout: 5000,
    };
    createSecureContext(tls);
    return tls;
  } catch {
    // Never expose a key, PEM parse error, filename or operator configuration in public diagnostics.
    throw new Error("TLS certificate/key configuration is invalid.");
  }
}
