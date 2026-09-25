import type { RunFrame } from "@openbot/domain";
import type { NodeMessage } from "@openbot/protocol";

const maxFrameBytes = 2 * 1024 * 1024;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type RunFrameMessage = Extract<NodeMessage, { type: "run.frame" }>;

export interface StoredRunFrame {
  frame: RunFrame;
  bytes: Buffer;
}

interface CacheEntry extends StoredRunFrame {
  expiresAt: number;
}

export class RunFrameStore {
  readonly #frames = new Map<string, CacheEntry>();
  readonly #maxFrames: number;
  readonly #ttlMs: number;

  constructor(options: { maxFrames?: number; ttlMs?: number } = {}) {
    this.#maxFrames = options.maxFrames ?? 16;
    this.#ttlMs = options.ttlMs ?? 120_000;
  }

  publish(channelId: string, message: RunFrameMessage): RunFrame | undefined {
    const bytes = Buffer.from(message.base64, "base64");
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > maxFrameBytes ||
      !bytes.subarray(0, pngSignature.length).equals(pngSignature)
    ) {
      return undefined;
    }

    const now = Date.now();
    this.#prune(now);
    const previous = this.#frames.get(message.runId);
    const frame: RunFrame = {
      runId: message.runId,
      channelId,
      nodeId: message.nodeId,
      revision: (previous?.frame.revision ?? 0) + 1,
      mediaType: "image/png",
      sizeBytes: bytes.byteLength,
      ...(message.width === undefined ? {} : { width: message.width }),
      ...(message.height === undefined ? {} : { height: message.height }),
      capturedAt: message.capturedAt,
    };

    this.#frames.delete(message.runId);
    this.#frames.set(message.runId, { frame, bytes, expiresAt: now + this.#ttlMs });
    this.#prune(now);
    return frame;
  }

  get(runId: string): StoredRunFrame | undefined {
    this.#prune(Date.now());
    const stored = this.#frames.get(runId);
    return stored === undefined ? undefined : { frame: stored.frame, bytes: stored.bytes };
  }

  delete(runId: string): void {
    this.#frames.delete(runId);
  }

  #prune(now: number): void {
    for (const [runId, entry] of this.#frames) {
      if (entry.expiresAt <= now) this.#frames.delete(runId);
    }
    while (this.#frames.size > this.#maxFrames) {
      const oldestRunId = this.#frames.keys().next().value as string | undefined;
      if (oldestRunId === undefined) return;
      this.#frames.delete(oldestRunId);
    }
  }
}
