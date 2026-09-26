import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmployeeProfile } from "@openbot/domain";
import { afterEach, describe, expect, it } from "vitest";
import { buildEmployeeTemplate } from "./employee-package.js";
import {
  EmployeePublisherKeyring,
  exportEmployeePublisherPublicKey,
  initializeEmployeePublisherKeyring,
  revokeEmployeePublisherKey,
  rotateEmployeePublisherKeyring,
  trustEmployeePublisherKey,
  type EmployeePublisherKeyringLocation,
} from "./employee-publisher-keyring.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-09-04T00:00:00.000Z";
// These integration-style tests intentionally exercise the production key derivation settings.
// Keep their bounded CPU allowance local instead of weakening the repository-wide test timeout.
const encryptedKeyringTestTimeoutMs = 20_000;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Employee publisher keyring", { timeout: encryptedKeyringTestTimeoutMs }, () => {
  it("creates an encrypted Owner key without exposing private material in status", async () => {
    const location = await temporaryLocation();
    const status = await initializeEmployeePublisherKeyring(location, { now: new Date(timestamp) });
    const keyring = await EmployeePublisherKeyring.load(location);
    const envelope = keyring.sign(buildEmployeeTemplate(createProfile()).document);

    expect(status.activeKeyId).toMatch(/^ed25519:[a-f0-9]{64}$/);
    expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    expect((await readFile(location.passphraseFile, "utf8")).trim()).toHaveLength(43);
    expect(keyring.verify(envelope)).toMatchObject({
      status: "verified",
      trustedKeyId: status.activeKeyId,
    });
  });

  it("rotates the signer while retaining verification and can revoke the retired key", async () => {
    const location = await temporaryLocation();
    const initial = await initializeEmployeePublisherKeyring(location, {
      now: new Date("2026-09-04T00:00:00.000Z"),
    });
    const firstKeyring = await EmployeePublisherKeyring.load(location);
    const oldEnvelope = firstKeyring.sign(buildEmployeeTemplate(createProfile()).document);

    const rotated = await rotateEmployeePublisherKeyring(location, {
      now: new Date("2026-09-05T00:00:00.000Z"),
    });
    const secondKeyring = await EmployeePublisherKeyring.load(location);

    expect(rotated.activeKeyId).not.toBe(initial.activeKeyId);
    expect(rotated.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyid: initial.activeKeyId, status: "retired" }),
        expect.objectContaining({ keyid: rotated.activeKeyId, status: "active" }),
      ]),
    );
    expect(secondKeyring.verify(oldEnvelope)).toMatchObject({ status: "verified" });

    await revokeEmployeePublisherKey(location, initial.activeKeyId, {
      now: new Date("2026-09-06T00:00:00.000Z"),
    });
    const revokedKeyring = await EmployeePublisherKeyring.load(location);
    expect(revokedKeyring.verify(oldEnvelope)).toMatchObject({
      status: "rejected",
      code: "no-trusted-signature",
    });
  });

  it("refuses to revoke the active signer", async () => {
    const location = await temporaryLocation();
    const status = await initializeEmployeePublisherKeyring(location);

    await expect(revokeEmployeePublisherKey(location, status.activeKeyId)).rejects.toThrow(
      "Rotate the active Employee publisher key",
    );
  });

  it("trusts a transferred public key only after its out-of-band fingerprint matches", async () => {
    const publisherLocation = await temporaryLocation();
    const receiverLocation = await temporaryLocation();
    await initializeEmployeePublisherKeyring(publisherLocation);
    await initializeEmployeePublisherKeyring(receiverLocation);
    const publisher = await EmployeePublisherKeyring.load(publisherLocation);
    const envelope = publisher.sign(buildEmployeeTemplate(createProfile()).document);
    const exported = await exportEmployeePublisherPublicKey(publisherLocation);
    const publicKeyFile = join(receiverLocation.directory, "incoming-publisher.pem");
    await writeFile(publicKeyFile, exported.publicKey, { mode: 0o644 });

    await expect(
      trustEmployeePublisherKey(receiverLocation, publicKeyFile, `ed25519:${"0".repeat(64)}`),
    ).rejects.toThrow("does not match --expected-key-id");
    await trustEmployeePublisherKey(receiverLocation, publicKeyFile, exported.keyid);

    const receiver = await EmployeePublisherKeyring.load(receiverLocation);
    expect(receiver.verify(envelope)).toMatchObject({
      status: "verified",
      trustedKeyId: exported.keyid,
    });
  });

  it("fails closed for a wrong passphrase and unsafe file permissions", async () => {
    const location = await temporaryLocation();
    const status = await initializeEmployeePublisherKeyring(location);
    await writeFile(location.passphraseFile, "this-is-the-wrong-passphrase\n", { mode: 0o600 });
    await expect(EmployeePublisherKeyring.load(location)).rejects.toThrow("could not be decrypted");

    if (process.platform !== "win32") {
      await chmod(location.passphraseFile, 0o644);
      await expect(EmployeePublisherKeyring.load(location)).rejects.toThrow(
        "must not be accessible by group or other users",
      );

      await chmod(location.passphraseFile, 0o600);
      await chmod(join(location.directory, "trust.json"), 0o644);
      await expect(EmployeePublisherKeyring.load(location)).rejects.toThrow(
        "trust manifest must not be accessible by group or other users",
      );

      await chmod(join(location.directory, "trust.json"), 0o600);
      const privateKeyName = `${status.activeKeyId.slice("ed25519:".length)}.key.pem`;
      await chmod(join(location.directory, "keys", privateKeyName), 0o644);
      await expect(EmployeePublisherKeyring.load(location)).rejects.toThrow(
        "private key must not be accessible by group or other users",
      );
    }
  });

  it("rejects symlinked passphrase input", async () => {
    const location = await temporaryLocation();
    await initializeEmployeePublisherKeyring(location);
    const link = join(location.directory, "passphrase-link");
    await symlink(location.passphraseFile, link);

    await expect(
      EmployeePublisherKeyring.load({ ...location, passphraseFile: link }),
    ).rejects.toThrow("regular non-symlink file");
  });

  it("rejects unknown manifest fields and a public-key fingerprint mismatch", async () => {
    const malformedLocation = await temporaryLocation();
    await initializeEmployeePublisherKeyring(malformedLocation);
    const malformedPath = join(malformedLocation.directory, "trust.json");
    const malformed = JSON.parse(await readFile(malformedPath, "utf8")) as Record<string, unknown>;
    malformed.unexpectedAuthority = true;
    await writeFile(malformedPath, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
    await expect(EmployeePublisherKeyring.load(malformedLocation)).rejects.toThrow(
      "trust manifest is invalid",
    );

    const mismatchLocation = await temporaryLocation();
    await initializeEmployeePublisherKeyring(mismatchLocation);
    const mismatchPath = join(mismatchLocation.directory, "trust.json");
    const mismatch = JSON.parse(await readFile(mismatchPath, "utf8")) as {
      keys: Array<{ publicKey: string }>;
    };
    const unrelated = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const firstKey = mismatch.keys[0];
    if (firstKey === undefined) throw new Error("Expected an initialized publisher key.");
    firstKey.publicKey = unrelated.publicKey;
    await writeFile(mismatchPath, `${JSON.stringify(mismatch)}\n`, { mode: 0o600 });
    await expect(EmployeePublisherKeyring.load(mismatchLocation)).rejects.toThrow(
      "does not match its fingerprint",
    );
  });
});

async function temporaryLocation(): Promise<EmployeePublisherKeyringLocation> {
  const root = await mkdtemp(join(tmpdir(), "openbot-publisher-keyring-"));
  temporaryDirectories.push(root);
  return {
    directory: join(root, "keyring"),
    passphraseFile: join(root, "secret", "passphrase"),
  };
}

function createProfile(): EmployeeProfile {
  return {
    employee: {
      id: "source-bot-id",
      name: "Ops",
      role: "Browser operations",
      status: "idle",
      computerProfile: "docker-linux",
      createdAt: timestamp,
    },
    details: { description: "", revision: 1, updatedAt: timestamp },
    evolution: [],
    skills: [],
    memories: [],
    memoryEvents: [],
    records: { runs: [], approvals: [], artifacts: [], decisions: [] },
    statistics: { totalRuns: 0, completedRuns: 0, failedRuns: 0, verifiedSkills: 0 },
    configuration: {
      executionProfile: "docker-linux",
      portabilityFormat: "openbot.employee/v1",
    },
  };
}
