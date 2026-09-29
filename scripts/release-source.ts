import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Source identity and trusted build-output digests shared by platform packagers.
 * Runtime, archive, toolchain and signing policy remain in platform modules.
 */
const RELEASE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MAXIMUM_SOURCE_DATE_EPOCH = 4_102_444_800;

export function assertReleaseVersion(version: unknown): string {
  if (
    typeof version !== "string" ||
    version.length > 64 ||
    !RELEASE_VERSION_PATTERN.test(version)
  ) {
    throw new Error("Release version must be a bounded SemVer value.");
  }
  return version;
}

export function assertSourceCommit(commit: unknown): string {
  if (typeof commit !== "string" || !SOURCE_COMMIT_PATTERN.test(commit)) {
    throw new Error("Source commit must be a full lowercase Git SHA-1.");
  }
  return commit;
}

export function assertSourceDateEpoch(value: unknown): number {
  const epoch = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > MAXIMUM_SOURCE_DATE_EPOCH) {
    throw new Error("Source date epoch must be an integer between 1970 and 2100.");
  }
  return epoch;
}

export function assertSourceTreeState(
  sourceCommit: unknown,
  headCommit: string,
  porcelainStatus: string,
): void {
  assertSourceCommit(sourceCommit);
  if (headCommit.trim() !== sourceCommit) {
    throw new Error("Source commit does not match repository HEAD.");
  }
  if (porcelainStatus.trim() !== "") {
    throw new Error("Release candidate requires a clean source tree.");
  }
}

/**
 * Trusted paths only: follows symbolic links and reads until EOF. Untrusted installer
 * inputs must use the platform's bounded O_NOFOLLOW | O_NONBLOCK digest instead.
 */
export async function sha256File(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  const stream: AsyncIterable<Buffer> = createReadStream(filePath);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
}
