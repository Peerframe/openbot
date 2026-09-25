import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DsseEnvelope, EmployeeTemplatePackage } from "@openbot/protocol";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  type EmployeeTemplateEnvelopeVerification,
  type EmployeeTemplateTrustedKey,
  signEmployeeTemplateEnvelope,
  verifyEmployeeTemplateEnvelope,
} from "./employee-package.js";

const manifestFileName = "trust.json";
const keyIdExpression = /^ed25519:([a-f0-9]{64})$/;
const maximumManifestBytes = 512 * 1024;
const keyEntrySchema = z
  .object({
    keyid: z.string().regex(keyIdExpression),
    algorithm: z.literal("ed25519"),
    status: z.enum(["active", "retired", "trusted", "revoked"]),
    publicKey: z.string().min(1).max(16_384),
    createdAt: z.string().datetime(),
    retiredAt: z.string().datetime().optional(),
    revokedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.status === "active" &&
      (entry.retiredAt !== undefined || entry.revokedAt !== undefined)
    ) {
      context.addIssue({ code: "custom", message: "An active key cannot be retired or revoked." });
    }
    if (entry.status === "retired" && entry.retiredAt === undefined) {
      context.addIssue({ code: "custom", message: "A retired key requires retiredAt." });
    }
    if (
      entry.status === "trusted" &&
      (entry.retiredAt !== undefined || entry.revokedAt !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A trusted key cannot be locally retired or revoked.",
      });
    }
    if (entry.status === "revoked" && entry.revokedAt === undefined) {
      context.addIssue({ code: "custom", message: "A revoked key requires revokedAt." });
    }
  });
const keyringManifestSchema = z
  .object({
    version: z.literal(1),
    activeKeyId: z.string().regex(keyIdExpression),
    keys: z.array(keyEntrySchema).min(1).max(256),
  })
  .strict();

type EmployeePublisherKeyEntry = z.infer<typeof keyEntrySchema>;
export type EmployeePublisherKeyringManifest = z.infer<typeof keyringManifestSchema>;

export interface EmployeePublisherKeyringLocation {
  directory: string;
  passphraseFile: string;
}

export interface EmployeePublisherKeyringStatus {
  activeKeyId: string;
  keys: Array<
    Pick<EmployeePublisherKeyEntry, "keyid" | "status" | "createdAt" | "retiredAt" | "revokedAt">
  >;
}

export interface EmployeePublisherPublicKey {
  keyid: string;
  algorithm: "ed25519";
  publicKey: string;
}

/**
 * Loaded, immutable publisher state. Mutation happens only through offline operator commands, so a
 * running Server cannot rotate its own trust root through HTTP input.
 */
export class EmployeePublisherKeyring {
  readonly activeKeyId: string;
  readonly #privateKey: KeyObject;
  readonly #trustedKeys: readonly EmployeeTemplateTrustedKey[];

  private constructor(
    activeKeyId: string,
    privateKey: KeyObject,
    trustedKeys: readonly EmployeeTemplateTrustedKey[],
  ) {
    this.activeKeyId = activeKeyId;
    this.#privateKey = privateKey;
    this.#trustedKeys = trustedKeys;
  }

  static async load(location: EmployeePublisherKeyringLocation): Promise<EmployeePublisherKeyring> {
    const normalized = normalizeLocation(location);
    await assertProtectedDirectory(normalized.directory);
    const manifest = await readManifest(normalized.directory);
    const { activeEntry, trustedKeys } = normalizeManifestKeys(manifest);
    const passphrase = await readProtectedPassphrase(normalized.passphraseFile);
    const privateKeyPath = privateKeyPathFor(normalized.directory, activeEntry.keyid);
    const privateKeyPem = await readProtectedFile(privateKeyPath, 64 * 1024, "private key");

    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: privateKeyPem, format: "pem", passphrase });
    } catch {
      throw new Error("Employee publisher private key could not be decrypted.");
    }
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Employee publisher private key must use Ed25519.");
    }
    const derivedId = keyIdForPublicKey(createPublicKey(privateKey));
    if (derivedId !== activeEntry.keyid) {
      throw new Error("Employee publisher private key does not match the active public key.");
    }

    return new EmployeePublisherKeyring(manifest.activeKeyId, privateKey, trustedKeys);
  }

  sign(document: EmployeeTemplatePackage): DsseEnvelope {
    return signEmployeeTemplateEnvelope(document, {
      keyid: this.activeKeyId,
      privateKey: this.#privateKey,
    });
  }

  verify(input: unknown): EmployeeTemplateEnvelopeVerification {
    return verifyEmployeeTemplateEnvelope(input, this.#trustedKeys);
  }
}

export async function initializeEmployeePublisherKeyring(
  location: EmployeePublisherKeyringLocation,
  options: { now?: Date } = {},
): Promise<EmployeePublisherKeyringStatus> {
  const normalized = normalizeLocation(location);
  await mkdir(normalized.directory, { recursive: true, mode: 0o700 });
  await chmod(normalized.directory, 0o700);
  await assertProtectedDirectory(normalized.directory);
  await assertManifestAbsent(normalized.directory);
  const passphrase = await ensurePassphraseFile(normalized.passphraseFile);
  const generated = generatePublisherKey(passphrase, options.now ?? new Date());
  await persistPrivateKey(normalized.directory, generated.entry.keyid, generated.privateKeyPem);
  const manifest = keyringManifestSchema.parse({
    version: 1,
    activeKeyId: generated.entry.keyid,
    keys: [generated.entry],
  });
  await persistManifest(normalized.directory, manifest);
  return statusFromManifest(manifest);
}

export async function rotateEmployeePublisherKeyring(
  location: EmployeePublisherKeyringLocation,
  options: { now?: Date } = {},
): Promise<EmployeePublisherKeyringStatus> {
  const normalized = normalizeLocation(location);
  await EmployeePublisherKeyring.load(normalized);
  const manifest = await readManifest(normalized.directory);
  if (manifest.keys.length >= 256) throw new Error("Employee publisher keyring is full.");
  const passphrase = await readProtectedPassphrase(normalized.passphraseFile);
  const now = (options.now ?? new Date()).toISOString();
  const generated = generatePublisherKey(passphrase, new Date(now));
  await persistPrivateKey(normalized.directory, generated.entry.keyid, generated.privateKeyPem);
  const nextManifest = keyringManifestSchema.parse({
    version: 1,
    activeKeyId: generated.entry.keyid,
    keys: [
      ...manifest.keys.map((key) =>
        key.keyid === manifest.activeKeyId
          ? { ...key, status: "retired" as const, retiredAt: now }
          : key,
      ),
      generated.entry,
    ],
  });
  await persistManifest(normalized.directory, nextManifest);
  return statusFromManifest(nextManifest);
}

export async function revokeEmployeePublisherKey(
  location: EmployeePublisherKeyringLocation,
  keyid: string,
  options: { now?: Date } = {},
): Promise<EmployeePublisherKeyringStatus> {
  const normalized = normalizeLocation(location);
  await EmployeePublisherKeyring.load(normalized);
  const manifest = await readManifest(normalized.directory);
  if (keyid === manifest.activeKeyId) {
    throw new Error("Rotate the active Employee publisher key before revoking it.");
  }
  const key = manifest.keys.find((candidate) => candidate.keyid === keyid);
  if (key === undefined) throw new Error(`Employee publisher key ${keyid} was not found.`);
  if (key.status === "revoked") return statusFromManifest(manifest);

  const now = (options.now ?? new Date()).toISOString();
  const nextManifest = keyringManifestSchema.parse({
    ...manifest,
    keys: manifest.keys.map((candidate) =>
      candidate.keyid === keyid
        ? { ...candidate, status: "revoked" as const, revokedAt: now }
        : candidate,
    ),
  });
  await persistManifest(normalized.directory, nextManifest);
  return statusFromManifest(nextManifest);
}

export async function trustEmployeePublisherKey(
  location: EmployeePublisherKeyringLocation,
  publicKeyFile: string,
  expectedKeyId: string,
  options: { now?: Date } = {},
): Promise<EmployeePublisherKeyringStatus> {
  const normalized = normalizeLocation(location);
  await EmployeePublisherKeyring.load(normalized);
  const manifest = await readManifest(normalized.directory);
  if (manifest.keys.length >= 256) throw new Error("Employee publisher keyring is full.");
  const source = await readRegularFile(resolve(publicKeyFile), 16_384, "public key");
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(source);
  } catch {
    throw new Error("Trusted Employee publisher key is not valid SPKI PEM.");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Trusted Employee publisher key must use Ed25519.");
  }
  const keyid = keyIdForPublicKey(publicKey);
  if (keyid !== expectedKeyId) {
    throw new Error("Trusted Employee publisher key does not match --expected-key-id.");
  }
  const existing = manifest.keys.find((key) => key.keyid === keyid);
  if (existing?.status === "revoked") {
    throw new Error("A revoked Employee publisher key cannot be trusted again.");
  }
  if (existing !== undefined) return statusFromManifest(manifest);

  const entry: EmployeePublisherKeyEntry = {
    keyid,
    algorithm: "ed25519",
    status: "trusted",
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  const nextManifest = keyringManifestSchema.parse({
    ...manifest,
    keys: [...manifest.keys, entry],
  });
  await persistManifest(normalized.directory, nextManifest);
  return statusFromManifest(nextManifest);
}

export async function exportEmployeePublisherPublicKey(
  location: EmployeePublisherKeyringLocation,
  keyid?: string,
): Promise<EmployeePublisherPublicKey> {
  const normalized = normalizeLocation(location);
  await EmployeePublisherKeyring.load(normalized);
  const manifest = await readManifest(normalized.directory);
  const selectedKeyId = keyid ?? manifest.activeKeyId;
  const entry = manifest.keys.find((key) => key.keyid === selectedKeyId);
  if (entry === undefined)
    throw new Error(`Employee publisher key ${selectedKeyId} was not found.`);
  return { keyid: entry.keyid, algorithm: "ed25519", publicKey: entry.publicKey };
}

export async function readEmployeePublisherKeyringStatus(
  location: EmployeePublisherKeyringLocation,
): Promise<EmployeePublisherKeyringStatus> {
  const normalized = normalizeLocation(location);
  await EmployeePublisherKeyring.load(normalized);
  return statusFromManifest(await readManifest(normalized.directory));
}

function generatePublisherKey(passphrase: Buffer, now: Date) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase,
    },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const publicKeyObject = createPublicKey(publicKey);
  const entry: EmployeePublisherKeyEntry = {
    keyid: keyIdForPublicKey(publicKeyObject),
    algorithm: "ed25519",
    status: "active",
    publicKey,
    createdAt: now.toISOString(),
  };
  return { entry, privateKeyPem: privateKey };
}

function normalizeManifestKeys(manifest: EmployeePublisherKeyringManifest) {
  const keyIds = new Set<string>();
  const trustedKeys: EmployeeTemplateTrustedKey[] = [];
  let activeEntry: EmployeePublisherKeyEntry | undefined;
  for (const entry of manifest.keys) {
    if (keyIds.has(entry.keyid)) throw new Error(`Duplicate publisher key id: ${entry.keyid}`);
    keyIds.add(entry.keyid);
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(entry.publicKey);
    } catch {
      throw new Error(`Employee publisher key ${entry.keyid} is not valid SPKI PEM.`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519" || keyIdForPublicKey(publicKey) !== entry.keyid) {
      throw new Error(`Employee publisher key ${entry.keyid} does not match its fingerprint.`);
    }
    if (entry.status === "active") {
      if (activeEntry !== undefined)
        throw new Error("Employee publisher keyring has multiple active keys.");
      activeEntry = entry;
    }
    if (entry.status !== "revoked") trustedKeys.push({ keyid: entry.keyid, publicKey });
  }
  if (activeEntry === undefined || activeEntry.keyid !== manifest.activeKeyId) {
    throw new Error("Employee publisher keyring active key is missing or inconsistent.");
  }
  return { activeEntry, trustedKeys };
}

function keyIdForPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `ed25519:${createHash("sha256").update(der).digest("hex")}`;
}

function privateKeyPathFor(directory: string, keyid: string): string {
  const match = keyIdExpression.exec(keyid);
  if (match?.[1] === undefined) throw new Error("Invalid Employee publisher key id.");
  return join(directory, "keys", `${match[1]}.key.pem`);
}

async function persistPrivateKey(directory: string, keyid: string, privateKeyPem: string) {
  const keysDirectory = join(directory, "keys");
  await mkdir(keysDirectory, { recursive: true, mode: 0o700 });
  await chmod(keysDirectory, 0o700);
  const path = privateKeyPathFor(directory, keyid);
  await writeFileAtomic(path, privateKeyPem, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function persistManifest(directory: string, manifest: EmployeePublisherKeyringManifest) {
  const path = join(directory, manifestFileName);
  await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

async function readManifest(directory: string): Promise<EmployeePublisherKeyringManifest> {
  const source = await readProtectedFile(
    join(directory, manifestFileName),
    maximumManifestBytes,
    "trust manifest",
  );
  let value: unknown;
  try {
    value = JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error("Employee publisher trust manifest is not valid JSON.");
  }
  const parsed = keyringManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error("Employee publisher trust manifest is invalid.");
  return parsed.data;
}

async function ensurePassphraseFile(path: string): Promise<Buffer> {
  try {
    return await readProtectedPassphrase(path);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const passphrase = randomBytes(32).toString("base64url");
  await writeFileAtomic(path, `${passphrase}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return Buffer.from(passphrase, "utf8");
}

async function readProtectedPassphrase(path: string): Promise<Buffer> {
  const source = await readProtectedFile(path, 4096, "passphrase");
  const value = source.toString("utf8").replace(/\r?\n$/, "");
  if (value.length < 16 || value.length > 1024) {
    throw new Error("Employee publisher passphrase must contain 16 to 1024 characters.");
  }
  return Buffer.from(value, "utf8");
}

async function readProtectedFile(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  return readRegularFile(path, maximumBytes, label, true);
}

async function readRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
  requireOwnerOnly = false,
): Promise<Buffer> {
  const pathEntry = await lstat(path);
  if (!pathEntry.isFile() || pathEntry.isSymbolicLink()) {
    throw new Error(`Employee publisher ${label} must be a regular non-symlink file.`);
  }

  const handle = await open(
    path,
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Employee publisher ${label} must be a regular non-symlink file.`);
    }
    if (requireOwnerOnly && process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error(
        `Employee publisher ${label} must not be accessible by group or other users.`,
      );
    }
    if (metadata.size > maximumBytes) {
      throw new Error(`Employee publisher ${label} is too large.`);
    }
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertProtectedDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Employee publisher keyring must be a regular non-symlink directory.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Employee publisher keyring must not be accessible by group or other users.");
  }
}

async function assertManifestAbsent(directory: string): Promise<void> {
  try {
    await lstat(join(directory, manifestFileName));
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  throw new Error("Employee publisher keyring is already initialized.");
}

function normalizeLocation(
  location: EmployeePublisherKeyringLocation,
): EmployeePublisherKeyringLocation {
  const directory = resolve(location.directory);
  const passphraseFile = resolve(location.passphraseFile);
  if (basename(passphraseFile).length === 0) throw new Error("Passphrase file path is invalid.");
  return { directory, passphraseFile };
}

function statusFromManifest(
  manifest: EmployeePublisherKeyringManifest,
): EmployeePublisherKeyringStatus {
  return {
    activeKeyId: manifest.activeKeyId,
    keys: manifest.keys.map(({ keyid, status, createdAt, retiredAt, revokedAt }) => ({
      keyid,
      status,
      createdAt,
      ...(retiredAt === undefined ? {} : { retiredAt }),
      ...(revokedAt === undefined ? {} : { revokedAt }),
    })),
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
