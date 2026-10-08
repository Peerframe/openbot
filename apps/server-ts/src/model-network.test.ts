import { expect, it } from "vitest";
import {
  ConnectionPolicy,
  ModelConnections,
  modelPresets,
  type ResolvedConnection,
} from "./model-connections.js";
import { ModelNetwork, type ModelTransport, validateProbe } from "./model-network.js";
import { WriteFailure } from "./primary-bot-write.js";
import type { AuthorizedProductOperation } from "./product-identity.js";

const selected: ResolvedConnection = {
  connectionId: "fixture",
  revision: 1,
  presetId: "openai",
  protocol: "openai-chat",
  baseUrl: "https://api.openai.com/v1",
  modelId: "fixture/model",
  apiKey: "synthetic-network-fixture",
  source: "saved",
};
const chat = () => ({
  id: "fixture-response",
  model: "fixture/model",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const reply = (value: unknown, status = 200, headers: Record<string, string> = {}) => ({
  status,
  bytes: Buffer.from(JSON.stringify(value)),
  headers: new Headers({ "content-type": "application/json", ...headers }),
});
function fixture(transport: ModelTransport, revokedAt = Infinity) {
  const models = new ModelConnections("/unused-private-unit-key");
  models.resolve = async () => ({ ...selected });
  let checks = 0;
  const owner: AuthorizedProductOperation = async (operation) => {
    if (++checks >= revokedAt) throw new WriteFailure(401, { error: "Authentication required." });
    return operation(undefined as never);
  };
  return { network: new ModelNetwork(models, transport), owner };
}
it("keeps reviewed preset values and requires an explicit immutable endpoint allowlist", () => {
  const presets = modelPresets();
  expect(presets).toHaveLength(12);
  presets[0]!.endpoints[0]!.baseUrl = "https://foreign.example.test";
  expect(modelPresets()[0]!.endpoints[0]!.baseUrl).toBe("https://api.openai.com/v1");
  const urls = ["https://custom.example.test/v1///"],
    policy = new ConnectionPolicy(urls);
  urls.push("https://foreign.example.test");
  expect(policy.endpoint("custom", "https://custom.example.test/v1")).toBe(
    "https://custom.example.test/v1",
  );
  expect(() => policy.endpoint("custom", "https://foreign.example.test")).toThrow();
  expect(() =>
    policy.endpoint("openai", "https://api.openai.com/v1", "anthropic-messages"),
  ).toThrow();
});
it("filters discovery duplicates, malformed ids and secret echoes with a 256 result bound", async () => {
  let sends = 0;
  const { network, owner } = fixture(async (request) => {
    sends++;
    expect(request.method).toBe("GET");
    return reply({
      data: [
        null,
        { id: selected.apiKey },
        { id: "bad space" },
        { id: " fixture/model " },
        { id: "fixture/model" },
        ...Array.from({ length: 300 }, (_, i) => ({ id: `model-${i}` })),
      ],
    });
  });
  const result = await network.discover(
    owner,
    selected.connectionId,
    null,
    new AbortController().signal,
  );
  expect(sends).toBe(1);
  expect(result.models).toHaveLength(256);
  expect(result.models[0]).toBe("fixture/model");
  expect(result.models).not.toContain(selected.apiKey);
});
it.each([2, 3])(
  "rechecks authority at boundary %s without retrying or exposing provider detail",
  async (revoke) => {
    let sends = 0;
    const { network, owner } = fixture(async () => {
      sends++;
      return reply(chat());
    }, revoke);
    await expect(
      network.test(
        owner,
        selected.connectionId,
        { modelId: selected.modelId },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(sends).toBe(revoke === 2 ? 0 : 1);
  },
);
it.each([401, 429, 503, 302])(
  "refuses provider status %s with exactly one request",
  async (status) => {
    let sends = 0;
    const { network, owner } = fixture(async () => {
      sends++;
      return reply({ error: { message: selected.apiKey } }, status);
    });
    await expect(
      network.test(
        owner,
        selected.connectionId,
        { modelId: selected.modelId },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 422, body: { error: "model_provider_unavailable" } });
    expect(sends).toBe(1);
  },
);
it("bounds declared and streamed responses and refuses encoded bodies", async () => {
  for (const response of [
    reply({}, 200, { "content-length": String(2 * 1024 * 1024 + 1) }),
    reply({}, 200, { "content-encoding": "gzip" }),
    { ...reply({}), bytes: Buffer.alloc(2 * 1024 * 1024 + 1) },
  ]) {
    const { network, owner } = fixture(async () => response);
    await expect(
      network.discover(owner, selected.connectionId, null, new AbortController().signal),
    ).rejects.toMatchObject({ status: 422 });
  }
});
it("keeps both slots occupied until cancelled transport work actually settles", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sends = 0;
  const { network, owner } = fixture(async () => {
    sends++;
    await pending;
    return reply({ data: [] });
  });
  const controller = new AbortController();
  const first = network
    .discover(owner, selected.connectionId, null, controller.signal)
    .catch((error) => error);
  const second = network
    .discover(owner, selected.connectionId, null, controller.signal)
    .catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await expect(
    network.discover(owner, selected.connectionId, null, new AbortController().signal),
  ).rejects.toMatchObject({ body: { error: "model_connection_checks_busy" } });
  release();
  await Promise.all([first, second]);
  expect(sends).toBe(2);
  expect(
    await network.discover(owner, selected.connectionId, null, new AbortController().signal),
  ).toEqual({ models: [] });
});
it("rejects unauthorized tools, bad usage totals, hidden recursion and non-finite numbers", () => {
  for (const transform of [
    (v: ReturnType<typeof chat>) => {
      v.usage.total_tokens = 9;
    },
    (v: ReturnType<typeof chat>) => {
      v.choices[0]!.finish_reason = "tool_calls";
    },
    (v: ReturnType<typeof chat>) => {
      Object.assign(v, { extra: Infinity });
    },
    (v: ReturnType<typeof chat>) => {
      Object.assign(v, {
        extra: Array.from({ length: 15 }).reduce<unknown>((child) => [child], null),
      });
    },
  ]) {
    const value = chat();
    transform(value);
    expect(() => validateProbe(value, selected)).toThrow();
  }
});
