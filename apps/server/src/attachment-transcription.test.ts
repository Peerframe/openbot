import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import { expect, it } from "vitest";
import { AttachmentTranscription } from "./attachment-transcription.js";
import type { ModelConnections, ResolvedConnection } from "./model-connections.js";
import { type ByteProviderTransport } from "./model-network.js";
import { OwnerFiles } from "./owner-files.js";
import type { AuthorizedProductOperation } from "./product-identity.js";
const chosen: ResolvedConnection = {
  connectionId: "fixture",
  revision: 1,
  presetId: "openai",
  protocol: "openai-chat",
  baseUrl: "https://api.openai.com/v1",
  modelId: "whisper-1",
  apiKey: "synthetic-audio-fixture",
  source: "saved",
};
const owner: AuthorizedProductOperation = async (action) =>
  action((async () => [
    { transcription_connection_id: "fixture" },
  ]) as unknown as postgres.TransactionSql);
async function fixture(operation: (files: OwnerFiles) => Promise<void>) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "openbot-audio-")),
    files = new OwnerFiles(join(root, "files"));
  files.verify();
  try {
    await operation(files);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
it("uses the real OpenAI SDK with one fixed bounded multipart upload and isolated headers", () =>
  fixture(async (files) => {
    const bytes = Buffer.from("ID3Synthetic media only"),
      item = await files.withLock(async (session) => session.persist(null, "Audio.mp3", bytes));
    let calls = 0;
    const transport: ByteProviderTransport = async (input) => {
      calls++;
      expect(input.url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(input.method).toBe("POST");
      expect(input.maximum).toBe(2097152);
      expect(input.responseKind).toBe("transcription");
      expect(Object.keys(input.headers).sort()).toEqual(
        ["Accept", "Accept-Encoding", "Authorization", "Content-Length", "Content-Type"].sort(),
      );
      expect(input.headers.Authorization).toBe("Bearer " + chosen.apiKey);
      const request = new Request(input.url, {
          method: "POST",
          headers: input.headers,
          body: new Uint8Array(input.body as Buffer),
        }),
        form = await request.formData();
      expect(form.get("model")).toBe("whisper-1");
      expect(form.get("response_format")).toBe("json");
      const file = form.get("file") as File;
      expect(file.name).toBe(item.name);
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        bytes: Buffer.from(JSON.stringify({ text: "Synthetic transcript" })),
      };
    };
    const service = new AttachmentTranscription(
      { resolve: async () => chosen } as unknown as ModelConnections,
      files,
      transport,
    );
    expect(
      await service.transcribe(owner, null, item, bytes, new AbortController().signal),
    ).toEqual({ text: "Synthetic transcript", truncated: false });
    expect(calls).toBe(1);
  }));
it("rechecks credential revision immediately before transfer without a retry", () =>
  fixture(async (files) => {
    const bytes = Buffer.from("ID3Synthetic media"),
      item = await files.withLock(async (session) => session.persist(null, "Audio.mp3", bytes));
    let reads = 0,
      calls = 0;
    const models = {
      resolve: async () =>
        ++reads === 3 ? { ...chosen, revision: 2, apiKey: "synthetic-rotated" } : chosen,
    } as unknown as ModelConnections;
    const service = new AttachmentTranscription(models, files, async () => {
      calls++;
      throw new Error("Unexpected provider transfer.");
    });
    await expect(
      service.transcribe(owner, null, item, bytes, new AbortController().signal),
    ).rejects.toMatchObject({ status: 409, body: { error: "model_connection_revision_conflict" } });
    expect(calls).toBe(0);
  }));
it("bounds raw provider bytes and hides provider error text", () =>
  fixture(async (files) => {
    const bytes = Buffer.from("ID3Synthetic media"),
      item = await files.withLock(async (session) => session.persist(null, "Audio.mp3", bytes));
    for (const [status, body, expected] of [
      [200, Buffer.alloc(2097153), 413],
      [401, Buffer.from("private provider message"), 503],
    ] as const) {
      let calls = 0;
      const service = new AttachmentTranscription(
        { resolve: async () => chosen } as unknown as ModelConnections,
        files,
        async () => {
          calls++;
          return { status, bytes: body, headers: new Headers() };
        },
      );
      await expect(
        service.transcribe(owner, null, item, bytes, new AbortController().signal),
      ).rejects.toMatchObject({ status: expected });
      expect(calls).toBe(1);
    }
  }));
