import { expect, it } from "vitest";
import type { ResolvedConnection } from "./model-connections.js";
import { invokeWorkModel, parseWorkModel, parseWorkVerdict } from "./work-model.js";

const selected: ResolvedConnection = {
  connectionId: "synthetic",
  revision: 1,
  presetId: "openai",
  protocol: "openai-chat",
  baseUrl: "https://api.openai.com/v1",
  modelId: "synthetic",
  apiKey: "synthetic-only",
  source: "saved",
};
const response = {
  id: "synthetic",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Ready" } }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
};
it("preserves provider usage and rejects duplicate tool correlation and malformed usage", () => {
  expect(parseWorkModel("openai-chat", response).actualTokens).toBe(6);
  expect(() =>
    parseWorkModel("openai-chat", { ...response, usage: { ...response.usage, total_tokens: 5 } }),
  ).toThrow();
  const call = {
    id: "same",
    type: "function",
    function: { name: "write_report", arguments: "{}" },
  };
  expect(() =>
    parseWorkModel("openai-chat", {
      ...response,
      choices: [
        {
          finish_reason: "tool_calls",
          message: { role: "assistant", content: null, tool_calls: [call, call] },
        },
      ],
    }),
  ).toThrow();
});
it("counts Anthropic cache usage and preserves original signed thinking for continuation", () => {
  const content = [
    { type: "thinking", thinking: "synthetic", signature: "signed-fixture" },
    { type: "text", text: "Ready" },
  ];
  const result = parseWorkModel("anthropic-messages", {
    type: "message",
    role: "assistant",
    stop_reason: "end_turn",
    content,
    usage: {
      input_tokens: 2,
      output_tokens: 3,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 5,
    },
  });
  expect(result.actualTokens).toBe(14);
  expect(result.message.content).toEqual(content);
});
it("uses one explicit POST with no retry after lost transport and checks live authority before send", async () => {
  const input = { system: "Bounded fixture", prompt: "Synthetic", turns: [], tools: false };
  let sends = 0,
    checks = 0;
  const transport = async () => {
    sends++;
    throw new Error("synthetic response loss");
  };
  await expect(
    invokeWorkModel(
      selected,
      input,
      async () => {
        checks++;
      },
      new AbortController().signal,
      transport,
    ),
  ).rejects.toThrow();
  expect([sends, checks]).toEqual([1, 1]);
  await expect(
    invokeWorkModel(
      selected,
      input,
      async () => {
        throw new Error("revoked");
      },
      new AbortController().signal,
      transport,
    ),
  ).rejects.toThrow();
  expect(sends).toBe(1);
});
it("keeps the independent verdict closed and refuses duplicates including escaped keys", () => {
  expect(parseWorkVerdict('{"reason":"Enough evidence","accepted":true}')).toEqual({
    reason: "Enough evidence",
    accepted: true,
  });
  for (const raw of [
    '{"accepted":true,"accepted":false,"reason":"x"}',
    '{"accepted":true,"\\u0061ccepted":true,"reason":"x"}',
    '{"accepted":true,"reason":"x","extra":false}',
    '{"accepted":1,"reason":"x"}',
    '{"accepted":true,"reason":""}',
    '{"accepted":true,"reason":"x",}',
  ])
    expect(() => parseWorkVerdict(raw)).toThrow();
});
