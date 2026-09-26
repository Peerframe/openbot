import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Artifact } from "@openbot/domain";
import type { CompletedArtifact } from "@openbot/protocol";
import writeFileAtomic from "write-file-atomic";

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PersistedArtifact {
  artifact: Artifact;
  storageKey: string;
  metadata: Record<string, unknown>;
}

export interface ArtifactStorage {
  persist(runId: string, inputs: ArtifactInput[]): Promise<PersistedArtifact[]>;
  read(storageKey: string): Promise<Buffer>;
  remove(storageKeys: string[]): Promise<void>;
}

/** Native text outputs are Server-owned; this does not expand the Worker PNG wire protocol. */
export interface NativeReportArtifact {
  name: string;
  mediaType: "text/markdown";
  text: string;
  metadata?: Record<string, unknown> | undefined;
}
export type ArtifactInput = CompletedArtifact | NativeReportArtifact;

export class FileArtifactStorage implements ArtifactStorage {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async persist(runId: string, inputs: ArtifactInput[]): Promise<PersistedArtifact[]> {
    const persisted: PersistedArtifact[] = [];
    try {
      for (const input of inputs) {
        const bytes =
          input.mediaType === "image/png" ? decodePng(input.base64) : decodeReport(input);
        const id = randomUUID();
        const extension = input.mediaType === "image/png" ? "png" : "md";
        const storageKey = `runs/${runId}/${id}.${extension}`;
        const destination = this.#pathFor(storageKey);
        await mkdir(dirname(destination), { recursive: true });
        // The maintained npm primitive fsyncs, renames, and removes its temporary file on failure.
        await writeFileAtomic(destination, bytes, { mode: 0o600 });
        persisted.push({
          artifact: {
            id,
            runId,
            name: input.name,
            mediaType: input.mediaType,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.byteLength,
            createdAt: new Date().toISOString(),
          },
          storageKey,
          metadata: { ...(input.metadata ?? {}), sizeBytes: bytes.byteLength },
        });
      }
      return persisted;
    } catch (error) {
      await this.remove(persisted.map((item) => item.storageKey));
      throw error;
    }
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFile(this.#pathFor(storageKey));
  }

  async remove(storageKeys: string[]): Promise<void> {
    await Promise.all(
      storageKeys.map(async (storageKey) => {
        try {
          await rm(this.#pathFor(storageKey), { force: true });
        } catch {
          // Rollback cleanup is best-effort; the persistence failure remains the primary error.
        }
      }),
    );
  }

  #pathFor(storageKey: string): string {
    if (!/^runs\/[0-9a-f-]+\/[0-9a-f-]+\.(?:png|md)$/i.test(storageKey)) {
      throw new Error("Invalid artifact storage key.");
    }
    const path = resolve(this.#root, storageKey);
    if (!path.startsWith(`${this.#root}${sep}`)) throw new Error("Artifact path escaped its root.");
    return path;
  }
}

export function decodeReport(input: NativeReportArtifact): Buffer {
  if (
    input.mediaType !== "text/markdown" ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,100}\.md$/u.test(input.name) ||
    !input.text.trim() ||
    input.text.includes("\0")
  ) {
    throw new Error("Invalid Markdown report.");
  }
  const bytes = Buffer.from(input.text, "utf8");
  if (bytes.byteLength > 32 * 1024) throw new Error("Report exceeds the 32 KiB limit.");
  return bytes;
}

function decodePng(base64: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("Artifact image data is not valid base64.");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error("Artifact exceeds the 5 MiB limit.");
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Only PNG screenshot artifacts are accepted.");
  }
  return bytes;
}
