/** Publishes and verifies signed Employee packages using the configured local keyring. */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  keyringManifestSchema,
  normalizeManifestKeys,
  keyIdForPublicKey,
} from "@openbot/employee-publisher/publisher-keyring";
import {
  signEmployeeTemplateEnvelope,
  verifyEmployeeTemplateEnvelope,
  type EmployeeTemplateExportPublisher,
} from "@openbot/employee-publisher/employee-package";
import { openAt, openDirectory } from "./posix-files.js";
import { readFileAt } from "./owner-files.js";

function protectedDirectory(fd: number) {
  const info = fstatSync(fd);
  if (!info.isDirectory() || info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("Publisher directory protection failed.");
  return fd;
}
export function loadEmployeePublisher(location: {
  directory: string;
  passphraseFile: string;
}): EmployeeTemplateExportPublisher {
  const descriptors: number[] = [];
  try {
    const root = openDirectory(location.directory, false);
    descriptors.push(root);
    protectedDirectory(root);
    const manifest = keyringManifestSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          readFileAt(root, "trust.json", 512 * 1024, true),
        ),
      ),
    );
    const { activeEntry, trustedKeys } = normalizeManifestKeys(manifest);
    const secretRoot = openDirectory(dirname(location.passphraseFile), false);
    descriptors.push(secretRoot);
    let password = new TextDecoder("utf-8", { fatal: true }).decode(
      readFileAt(secretRoot, basename(location.passphraseFile), 4096, true),
    );
    password = password.replace(/\r?\n$/, "");
    if (password.length < 16 || password.length > 1024)
      throw new Error("Publisher passphrase bound.");
    const keys = openAt(root, "keys", constants.O_RDONLY | constants.O_DIRECTORY);
    descriptors.push(keys);
    protectedDirectory(keys);
    const pem = readFileAt(keys, activeEntry.keyid.slice(8) + ".key.pem", 65536, true);
    const privateKey = createPrivateKey({ key: pem, format: "pem", passphrase: password });
    if (
      privateKey.asymmetricKeyType !== "ed25519" ||
      keyIdForPublicKey(createPublicKey(privateKey)) !== activeEntry.keyid
    )
      throw new Error("Publisher key mismatch.");
    return {
      keyId: activeEntry.keyid,
      sign: (document) =>
        signEmployeeTemplateEnvelope(document, { keyid: activeEntry.keyid, privateKey }),
      verify: (input) => verifyEmployeeTemplateEnvelope(input, trustedKeys),
    };
  } catch {
    throw new Error("Employee publisher keyring could not be loaded.");
  } finally {
    for (const fd of descriptors.reverse()) closeSync(fd);
  }
}
