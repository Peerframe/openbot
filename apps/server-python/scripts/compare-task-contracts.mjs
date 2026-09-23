// Run the retained TypeScript functions and Python adapters against the same synthetic inputs.
// No model, database, inherited credentials, or caller-supplied path is involved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { selectChannelAssignees } from "../../server/dist/task-routing.js";
import { toRun } from "../../server/dist/postgres-task-records.js";

const root = new URL("../", import.meta.url);
const candidates = [
  { id: "a", name: "Analyst", role: "reviewer", computerProfile: "none" },
  { id: "b", name: "Coordinator", role: "CHIEF", computerProfile: "docker-linux" },
  { id: "c", name: "调度", role: "assistant", computerProfile: "none" },
];
const routing = [];
for (const members of [candidates, candidates.slice(0, 1), []]) {
  for (const input of [
    {},
    { botId: "a" },
    { botIds: ["c", "a"] },
    { botIds: ["a", "absent"] },
    { botIds: [] },
    { botIds: ["a", "a"] },
    { botId: "a", botIds: ["a"] },
  ]) {
    routing.push({ candidates: members, input });
  }
}
for (const input of [{}, { botId: "b" }, { botIds: ["b"] }, { botIds: ["a", "b"] }]) {
  routing.push({ candidates, input, directBotId: "b" });
}
const usage = {
  provider: "deepseek",
  model: "owner/model-v1",
  steps: 1,
  inputTokens: null,
  outputTokens: 3,
};
const row = {
  id: "run",
  channel_id: "channel",
  bot_id: "a",
  title: "task 🧪",
  instruction: null,
  execution_profile: "none",
  status: "queued",
  created_at: "2026-09-23T00:00:00.123Z",
  updated_at: "2026-09-23T00:00:00.123Z",
};
const runs = [
  row,
  {
    ...row,
    parent_run_id: "parent",
    root_run_id: "root",
    delegated_by_bot_id: "b",
    source_message_id: "",
    node_id: "",
    result_summary: "",
    error_message: "",
    error_code: "",
    instruction: "",
  },
];
for (const override of [
  {},
  { steps: 1.0 },
  { steps: 0 },
  { steps: 8 },
  { steps: 9 },
  { steps: true },
  { steps: "1" },
  { inputTokens: 0 },
  { inputTokens: 1_000_000_000 },
  { inputTokens: 1_000_000_001 },
  { inputTokens: -1 },
  { inputTokens: 1.5 },
  { inputTokens: false },
  { inputTokens: "1" },
  { outputTokens: null },
  { outputTokens: undefined },
  { cost: 1 },
  { provider: "unknown" },
  { model: "a\n" },
  { model: "a/b/c" },
  { model: "a".repeat(128) },
  { model: "a".repeat(129) },
]) {
  runs.push({ ...row, model_usage: { ...usage, ...override } });
}
for (const provider of [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "moonshot",
  "openrouter",
  "siliconflow",
  "dashscope",
  "zai",
  "minimax",
  "ark",
]) {
  runs.push({ ...row, model_usage: { ...usage, provider } });
}
const cases = JSON.parse(JSON.stringify({ routing, runs }));
const expected = {
  routing: cases.routing.map(({ candidates, input, directBotId }) => {
    try {
      return { ids: selectChannelAssignees(candidates, input, directBotId).map(({ id }) => id) };
    } catch (error) {
      return { error: error.message };
    }
  }),
  runs: cases.runs.map((source) => {
    const mapped = Object.fromEntries(
      Object.entries(source).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
        value,
      ]),
    );
    mapped.createdAt = new Date(mapped.createdAt);
    mapped.updatedAt = new Date(mapped.updatedAt);
    return toRun(mapped);
  }),
};
const program = `
import json, sys
from datetime import datetime
sys.path.insert(0, sys.argv[1])
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_routing import TaskCandidate, TaskValidation, select_assignees
from openbot_server.task_models import project_run
cases = json.load(sys.stdin)
result = {"routing": [], "runs": []}
for case in cases["routing"]:
    try:
        selected = select_assignees([TaskCandidate.model_validate(x) for x in case["candidates"]],
            CreateMessageInput.model_construct(content="task", **case["input"]), case.get("directBotId"))
        result["routing"].append({"ids": [x.id for x in selected]})
    except TaskValidation as error:
        result["routing"].append({"error": str(error)})
for row in cases["runs"]:
    for key in ("created_at", "updated_at"):
        row[key] = datetime.fromisoformat(row[key])
    result["runs"].append(project_run(row).model_dump(mode="json", exclude_none=True))
json.dump(result, sys.stdout, ensure_ascii=True)
`;
const child = spawnSync(
  fileURLToPath(new URL(".venv/bin/python", root)),
  ["-I", "-c", program, fileURLToPath(new URL("src", root))],
  {
    env: { PATH: "/usr/bin:/bin" },
    input: JSON.stringify(cases),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  },
);
assert.equal(child.status, 0, child.stderr);
assert.deepEqual(JSON.parse(child.stdout), expected);
console.log(
  `Task contracts: ${cases.routing.length} routing and ${cases.runs.length} Run/usage cases agree between TypeScript and Python.`,
);
