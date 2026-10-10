import { expect, it } from "vitest";
import { generateGreeting } from "./greeting-network.js";
import { plainGreeting } from "./greeting-text.js";
import type { ResolvedConnection } from "./model-connections.js";
import type { ModelTransport } from "./model-network.js";
const selected: ResolvedConnection = {
  connectionId: "fixture",
  revision: 1,
  presetId: "openai",
  protocol: "openai-chat",
  baseUrl: "https://api.openai.com/v1",
  modelId: "fixture/model",
  apiKey: "synthetic-greeting-value",
  source: "saved",
};
const greeting = "你好，我刚加入团队。你希望我负责哪些任务？";
const chat = (text = greeting) => ({
  id: "fixture",
  model: "fixture/model",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
  usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
});
const reply = (value: unknown) => ({
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  bytes: Buffer.from(JSON.stringify(value)),
});
it("strips untrusted formatting, reference markers and HTML entities with Python whitespace semantics", () => {
  expect(
    plainGreeting(
      "### **你好**，[团队](https://synthetic.invalid)。[OpenBot attachment: secret]\n你希望我负责什么任务？",
    ),
  ).toBe("你好，团队。你希望我负责什么任务？");
  expect(
    plainGreeting("<think>private</think>你好&#1;&#xFFFF;&amp;团队。\u0085你想让我做什么？"),
  ).toBe("你好&团队。你想让我做什么？");
  for (const value of [
    "",
    "hello?",
    "你喜欢什么颜色？",
    "我负责研究。你想做什么？还有什么？",
    "中".repeat(121) + "你想让我做什么？",
    "抱歉，我无法提供帮助。你需要做什么？",
  ])
    expect(() => plainGreeting(value)).toThrow();
});
it.each(["openai", "anthropic", "kimi", "openrouter", "minimax"])(
  "uses the actual %s SDK for one bounded text-only request",
  async (preset) => {
    let sent = 0,
      fresh = 0;
    const candidate = {
      ...selected,
      ...(preset === "anthropic"
        ? {
            protocol: "anthropic-messages" as const,
            presetId: "anthropic" as const,
            baseUrl: "https://api.anthropic.com",
          }
        : preset === "kimi"
          ? { presetId: "kimi" as const, modelId: "kimi-k3" }
          : preset === "openrouter"
            ? { presetId: "openrouter" as const }
            : preset === "minimax"
              ? { presetId: "minimax" as const }
              : {}),
    };
    const result = await generateGreeting(
      candidate,
      { name: "New", others: [{ name: "Peer", role: "Research" }] },
      async () => {
        fresh++;
      },
      new AbortController().signal,
      async (request) => {
        sent++;
        expect(request.maximum).toBe(32768);
        expect(request.headers["Accept-Encoding"]).toBe("identity");
        expect(request.signal.aborted).toBe(false);
        const body = JSON.parse(request.body!);
        expect(body.tools).toBeUndefined();
        expect(body.stream).toBeUndefined();
        expect(body.max_tokens ?? body.max_completion_tokens).toBe(256);
        expect(body.messages.at(-1).content).toBe(
          JSON.stringify({ name: "New", others: [{ name: "Peer", role: "Research" }] }),
        );
        if (preset === "openai") expect(body.store).toBe(false);
        if (preset === "kimi") expect(body.reasoning_effort).toBe("low");
        if (preset === "openrouter")
          expect(body.provider).toEqual({
            require_parameters: true,
            allow_fallbacks: false,
            data_collection: "deny",
          });
        if (preset === "minimax") expect(body.reasoning_split).toBe(true);
        return reply(
          preset === "anthropic"
            ? {
                id: "fixture",
                type: "message",
                role: "assistant",
                model: "fixture/model",
                content: [{ type: "text", text: greeting }],
                stop_reason: "end_turn",
                usage: { input_tokens: 10, output_tokens: 8 },
              }
            : chat(),
        );
      },
    );
    expect(result).toBe(greeting);
    expect(sent).toBe(1);
    expect(fresh).toBe(1);
  },
);
it("refuses tools, incomplete/refused/oversized/malformed/redirect/compressed provider results without retry", async () => {
  for (const variant of [
    "tools",
    "function",
    "length",
    "refusal",
    "oversize",
    "json",
    "redirect",
    "encoding",
  ]) {
    let calls = 0;
    const transport: ModelTransport = async () => {
      calls++;
      const body = chat() as any;
      const response = reply(body);
      if (variant === "tools") body.choices[0].message.tool_calls = [{ id: "bad" }];
      if (variant === "function") body.choices[0].message.function_call = { name: "bad" };
      if (variant === "length") body.choices[0].finish_reason = "length";
      if (variant === "refusal") body.choices[0].message.refusal = "private";
      response.bytes = Buffer.from(JSON.stringify(body));
      if (variant === "oversize") response.bytes = Buffer.alloc(32769);
      if (variant === "json") response.bytes = Buffer.from("private");
      if (variant === "redirect") response.status = 302;
      if (variant === "encoding") response.headers.set("content-encoding", "gzip");
      return response;
    };
    await expect(
      generateGreeting(selected, {}, async () => {}, new AbortController().signal, transport),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }
});
it("does not transmit after a failed freshness check or cancellation", async () => {
  let calls = 0;
  const transport: ModelTransport = async () => {
    calls++;
    return reply(chat());
  };
  await expect(
    generateGreeting(
      selected,
      {},
      async () => {
        throw new Error("revoked");
      },
      new AbortController().signal,
      transport,
    ),
  ).rejects.toThrow();
  await expect(
    generateGreeting(selected, {}, async () => {}, AbortSignal.abort(), transport),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
