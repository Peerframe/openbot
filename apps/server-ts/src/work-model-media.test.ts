import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { ResolvedConnection } from "./model-connections.js";
import { invokeWorkModel } from "./work-model.js";
import { type WorkMediaItem, workMediaWire } from "./work-model-media.js";
import { sha256 } from "./work-values.js";
const retained = JSON.parse(
  readFileSync(
    new URL("../../server-python/tests/fixtures/retained_media_wire.json", import.meta.url),
    "utf8",
  ),
);
const input = {
  system: "Synthetic fixture",
  prompt: "Read explicitly scoped attachments",
  turns: [],
  tools: false,
};
const selected: ResolvedConnection = {
  connectionId: "fixture",
  revision: 1,
  presetId: "openai",
  protocol: "openai-chat",
  baseUrl: "https://api.openai.com/v1",
  modelId: "synthetic",
  apiKey: "synthetic-only",
  source: "saved",
};
const samples: WorkMediaItem[] = retained[1].projection.map(
  (p: { mediaType: string; data: string; name: string | null }, i: number) => {
    const data = Buffer.from(p.data, "base64");
    return {
      attachmentId: String(i),
      name: p.name ?? `sample${i}.png`,
      mediaType: p.mediaType,
      sha256: sha256(data),
      data,
    };
  },
);
function reply(anthropic: boolean) {
  const value = anthropic
    ? {
        id: "fixture",
        type: "message",
        role: "assistant",
        model: "synthetic",
        content: [{ type: "text", text: "Ready" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      }
    : {
        id: "fixture",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "Ready" } },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      };
  return {
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    bytes: Buffer.from(JSON.stringify(value)),
  };
}
for (const anthropic of [false, true]) {
  const provider: ResolvedConnection = anthropic
    ? {
        ...selected,
        presetId: "anthropic",
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }
    : selected;
  it(`preserves retained original bytes and Chinese PDF name through ${provider.protocol} SDK`, async () => {
    let sent = 0,
      checked = 0;
    await invokeWorkModel(
      provider,
      input,
      async () => {
        checked++;
      },
      new AbortController().signal,
      async (request) => {
        sent++;
        const messages = JSON.parse(request.body!).messages,
          parts = messages.at(-1).content.slice(1);
        const projection = parts.map((part: Record<string, any>) => {
          const encoded = anthropic
            ? part.source.data
            : (part.type === "file" ? part.file.file_data : part.image_url.url).split(",")[1];
          return {
            mediaType: anthropic
              ? part.source.media_type
              : (part.type === "file" ? part.file.file_data : part.image_url.url)
                  .slice(5)
                  .split(";")[0],
            data: encoded,
            name: anthropic ? (part.title ?? null) : (part.file?.filename ?? null),
          };
        });
        expect(projection).toEqual(retained[anthropic ? 2 : 1].projection);
        expect(messages[0].content).toBe(anthropic ? input.prompt : input.system);
        return reply(anthropic);
      },
      samples,
    );
    expect([sent, checked]).toEqual([1, 1]);
  });
  it(`allows the retained 20 MiB raw cap only on the trusted ${provider.protocol} media path`, async () => {
    const data = Buffer.alloc(10 * 1024 * 1024, 65),
      digest = sha256(data);
    const items = [0, 1].map((i) => ({
      attachmentId: String(i),
      name: `sample${i}.pdf`,
      mediaType: "application/pdf",
      sha256: digest,
      data,
    }));
    let size = 0;
    await invokeWorkModel(
      provider,
      input,
      async () => {},
      new AbortController().signal,
      async (request) => {
        size = Buffer.byteLength(request.body!);
        return reply(anthropic);
      },
      items,
    );
    expect(size).toBeGreaterThan(20 * 1024 * 1024);
    expect(size).toBeLessThan(30 * 1024 * 1024);
  });
}
it("refuses unreviewed presets, changed bytes, oversized inputs and injected remote media before dispatch", async () => {
  let sent = 0;
  const send = async () => {
    sent++;
    return reply(false);
  };
  await expect(
    invokeWorkModel(
      { ...selected, presetId: "openrouter" },
      input,
      async () => {},
      new AbortController().signal,
      send,
      samples,
    ),
  ).rejects.toThrow();
  for (const bad of [
    samples.concat(samples[0]!),
    [{ ...samples[0]!, data: Buffer.from("changed") }],
    [{ ...samples[0]!, mediaType: "audio/wav" }],
  ])
    expect(() => workMediaWire(selected, bad)).toThrow();
  const wire = workMediaWire(selected, samples);
  const changed = structuredClone(wire.content) as any[];
  changed[1].image_url.url = "https://example.com/private.png";
  expect(() =>
    wire.assert(JSON.stringify({ messages: [{ role: "user", content: changed }] })),
  ).toThrow();
  await expect(
    invokeWorkModel(
      selected,
      input,
      async () => {
        throw new Error("revoked");
      },
      new AbortController().signal,
      send,
      samples,
    ),
  ).rejects.toThrow();
  expect(sent).toBe(0);
});
