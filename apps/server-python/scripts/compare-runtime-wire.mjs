// Independent actual TypeScript/Python profile comparison; no process, model or database effects.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimeWorkerMessageSchema } from "../../../tests/oracles/legacy-server/dist/agent-runtime-wire.js";

const request = (method, params = {}, id = "w1") => ({ jsonrpc: "2.0", id, method, params });
const final = (text) => ({ jsonrpc: "2.0", id: "run", result: { text } });
const denied = (reason) => ({
  jsonrpc: "2.0",
  id: "run",
  error: {
    code: -32000,
    message: "Runtime operation refused",
    data: { reason },
  },
});
const first = { role: "user", content: "Continue the Server-bound task." };
const call = { id: "c1", name: "read", arguments: { nested: [true, 1, null] } };
const cases = [
  null,
  [],
  "x",
  1,
  {},
  request("authority.check"),
  request("approval.grant"),
  request("authority.check", { extra: 1 }),
  { ...request("authority.check"), extra: 1 },
  ...["w0", "w1", "w512", "w513", "w999", "w1000", "run", 1].map((id) =>
    request("authority.check", {}, id),
  ),
  ...["", " ", "done", "😀".repeat(8000), "x".repeat(8001)].map(final),
  ...["refused", "task_limit", "", "UPPER", "x".repeat(64), "x".repeat(65)].map(denied),
  request("tool.execute", call),
  request("tool.execute", { ...call, extra: true }),
  request("tool.execute", { ...call, arguments: [] }),
  request("tool.execute", { ...call, id: "" }),
  request("tool.execute", { ...call, id: "c".repeat(257) }),
  request("model.generate", { messages: [first] }),
  request("model.generate", { messages: [] }),
  request("model.generate", { messages: Array(128).fill(first) }),
  request("model.generate", { messages: Array(129).fill(first) }),
  request("model.generate", { messages: [{ role: "system", content: "x" }] }),
  request("model.generate", { messages: [{ ...first, providerOptions: {} }] }),
  request("model.generate", {
    messages: [
      first,
      {
        role: "assistant",
        content: [
          { type: "text", text: "observing" },
          { type: "tool-call", toolCallId: "c1", toolName: "read", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read",
            output: { type: "json", value: { evidence: "事实" } },
          },
        ],
      },
    ],
  }),
  ...[
    [],
    [{ type: "image", image: "x" }],
    [{ type: "text", text: 1 }],
    [{ type: "tool-call", toolCallId: "c", toolName: "read", input: "{}" }],
  ].map((content) =>
    request("model.generate", { messages: [first, { role: "assistant", content }] }),
  ),
  request("model.generate", {
    messages: [
      first,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "read",
            output: { type: "text", value: "unpermitted" },
          },
        ],
      },
    ],
  }),
  { ...final("done"), error: denied("refused").error },
  { ...final("done"), id: "w1" },
  { ...denied("refused"), error: { code: -32600, message: "Invalid request" } },
];
const program = `
import json, sys
sys.path.insert(0, sys.argv[1])
from openbot_server.runtime_wire import validate_worker_message, RuntimeProtocolError
result=[]
for item in json.load(sys.stdin):
    try: result.append({"ok":True,"value":validate_worker_message(item)})
    except RuntimeProtocolError: result.append({"ok":False})
json.dump(result,sys.stdout,ensure_ascii=True)
`;
const root = new URL("../", import.meta.url);
const child = spawnSync(
  fileURLToPath(new URL(".venv/bin/python", root)),
  ["-I", "-c", program, fileURLToPath(new URL("src", root))],
  {
    input: JSON.stringify(cases),
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  },
);
assert.equal(child.status, 0, child.stderr);
const actual = JSON.parse(child.stdout);
const expected = cases.map((value) => {
  const result = runtimeWorkerMessageSchema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false };
});
for (let index = 0; index < cases.length; index++) {
  assert.deepEqual(actual[index], expected[index], `Runtime profile case ${index} differs`);
}
console.log(`Runtime profile: ${cases.length} actual TypeScript/Python cases agree.`);
