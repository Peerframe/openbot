/** Private disposable contract entry: only fixed synthetic model replies, never a live provider. */
import assert from "node:assert/strict";
import { lstatSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { entryOptions } from "../apps/server-ts/dist/config.js";
import { runEntry } from "../apps/server-ts/dist/lifetime.js";
import type { ModelTransport } from "../apps/server-ts/dist/model-network.js";

const path = process.argv[2];
assert(process.argv.length === 3 && path && isAbsolute(path));
const metadata = lstatSync(path);
assert(metadata.isFile() && (metadata.mode & 0o077) === 0);
const stats = { discovery: 0, probes: 0, refused: 0, modes: {} as Record<string, number> };
const save = () => writeFileSync(path, JSON.stringify(stats), { mode: 0o600 });
const reply = (status: number, value: unknown, extra: Record<string, string> = {}) => ({
  status,
  headers: new Headers({ "content-type": "application/json", ...extra }),
  bytes: Buffer.from(JSON.stringify(value)),
});
const transport: ModelTransport = async (request) => {
  const url = new URL(request.url);
  const allowed = new Set([
    "api.openai.com/v1/models GET",
    "api.openai.com/v1/chat/completions POST",
    "api.anthropic.com/v1/models GET",
    "api.anthropic.com/v1/messages POST",
  ]);
  const credential =
    request.headers["x-api-key"] ?? request.headers.Authorization?.replace(/^Bearer /, "") ?? "";
  const mode = credential.replace(/^synthetic-contract-/, "");
  if (
    url.protocol !== "https:" ||
    url.port ||
    !allowed.has(`${url.hostname}${url.pathname} ${request.method}`) ||
    !["success", "credentials", "redirect", "invalid-json", "oversize", "failure"].includes(mode)
  ) {
    stats.refused++;
    save();
    return reply(403, {});
  }
  stats[request.method === "GET" ? "discovery" : "probes"]++;
  stats.modes[mode] = (stats.modes[mode] ?? 0) + 1;
  assert(stats.discovery + stats.probes <= 100);
  save();
  if (mode === "credentials")
    return reply(401, { error: { message: "Synthetic private provider diagnostic" } });
  if (mode === "redirect") return reply(302, {}, { location: "https://foreign.invalid/private" });
  if (mode === "invalid-json")
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      bytes: Buffer.from("Synthetic private provider diagnostic"),
    };
  if (mode === "oversize") return reply(200, {}, { "content-length": String(2 * 1024 * 1024 + 1) });
  if (mode === "failure")
    return reply(503, { error: { message: "Synthetic private provider diagnostic" } });
  if (request.method === "GET") {
    assert.equal(url.search, url.hostname === "api.anthropic.com" ? "?limit=256" : "");
    if (url.hostname === "api.anthropic.com")
      assert.equal(request.headers["anthropic-version"], "2023-06-01");
    return reply(200, {
      data: [
        null,
        { id: "bad space" },
        { id: " contract/model " },
        { id: "contract/model" },
        { id: credential },
        ...Array.from({ length: 300 }, (_, i) => ({ id: `model-${i}` })),
      ],
    });
  }
  const body = JSON.parse(request.body!);
  assert(
    !body.tools &&
      body.model === "contract/model" &&
      body.messages.length === 1 &&
      body.messages[0].role === "user",
  );
  assert.equal(body.messages[0].content, "Reply with OK.");
  if (url.hostname === "api.anthropic.com")
    return reply(200, {
      id: "contract-message",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 4 },
    });
  return reply(200, {
    id: "contract-chat",
    object: "chat.completion",
    created: 1,
    model: body.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  });
};
const options = entryOptions(process.env);
assert(options.product?.models);
options.product.modelTransport = transport;
await runEntry(options);
