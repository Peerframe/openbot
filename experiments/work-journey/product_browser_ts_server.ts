/** The production P4 entry with only model HTTP replaced; Node and Chromium stay real. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import proto from "@temporalio/proto";
import { entryOptions } from "../../apps/server/src/config.js";
import { runEntry } from "../../apps/server/src/lifetime.js";
import type { ModelTransport } from "../../apps/server/src/model-network.js";

if (process.argv[2] === "--replay") {
  assert.equal(process.argv.length, 4);
  assert.ok(process.argv[3]);
  await Worker.runReplayHistory(
    {
      workflowsPath: fileURLToPath(
        new URL("../../packages/work/dist/workflows.js", import.meta.url),
      ),
    },
    proto.temporal.api.history.v1.History.decode(await readFile(process.argv[3])),
  );
} else {
  assert.equal(process.argv.length, 2);
  assert.ok(process.env.OPENBOT_BROWSER_PROBE_CONFIG);
  const config = JSON.parse(await readFile(process.env.OPENBOT_BROWSER_PROBE_CONFIG, "utf8"));
  const directory = dirname(config.directory);
  const counts: Record<string, number> = {};
  const text = "浏览器任务 你好 🌏";
  const summary = `The page displayed Saved: ${text}. The observed page result and report are attached.`;
  const report = `# Browser page result\n\nThe observed page displayed **Saved: ${text}**.\n`;
  const transport: ModelTransport = async (request) => {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    assert.ok(request.body);
    const body = JSON.parse(request.body);
    assert.equal(body.model, "synthetic-browser-model");
    const messages = body.messages as { role: string; content: string; tool_call_id?: string }[];
    const outputs = new Map(
      messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, JSON.parse(m.content)]),
    );
    const observed = (key: string) => {
      const value = outputs.get(key);
      assert.equal(value.status, "observed");
      assert.equal(value.untrusted, true);
      assert.equal(value.externalEffectVerified, false);
      return value as {
        observationId: string;
        page: { text: string; elements: { ref: string; role: string; name: string }[] };
      };
    };
    let step: string,
      content: string | null = null;
    let call:
      | { id: string; type: "function"; function: { name: string; arguments: string } }
      | undefined;
    const tool = (id: string, name: string, args: unknown) => {
      call = { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
    };
    assert.ok(messages[0] && messages[1]);
    if (messages[0].content.startsWith("Independently review")) {
      const proof = JSON.parse(messages[1].content);
      assert.equal(proof.answer, summary);
      assert.ok(proof.reports.some((r: { text: string }) => r.text === report));
      assert.ok(
        proof.toolObservations.some((o: { content: string }) =>
          JSON.parse(o.content).page?.text.includes(`Saved: ${text}`),
        ),
      );
      step = "review";
      content = JSON.stringify({
        accepted: true,
        reason: "Synthetic page text and complete report agree; no external transaction claimed.",
      });
    } else if (!outputs.has("page-navigate")) {
      step = "navigate";
      tool("page-navigate", "navigate_browser", { url: `${config.target}/` });
    } else if (!outputs.has("page-type")) {
      const value = observed("page-navigate");
      const element = value.page.elements.find((e) => e.role === "textbox");
      assert.ok(element);
      step = "type";
      tool("page-type", "type_browser", {
        observationId: value.observationId,
        ref: element.ref,
        text,
      });
    } else if (!outputs.has("page-click")) {
      const value = observed("page-type");
      const element = value.page.elements.find(
        (e) => e.role === "button" && e.name === "Save synthetic entry",
      );
      assert.ok(element);
      step = "click";
      tool("page-click", "click_browser", { observationId: value.observationId, ref: element.ref });
    } else if (!outputs.has("page-read")) {
      assert.ok(observed("page-click").page.text.includes(`Saved: ${text}`));
      step = "read";
      tool("page-read", "read_browser", {});
    } else if (!outputs.has("page-report")) {
      assert.ok(observed("page-read").page.text.includes(`Saved: ${text}`));
      step = "report";
      tool("page-report", "write_report", { name: "browser-report.md", markdown: report });
    } else {
      step = "final";
      content = summary;
    }
    counts[step] = (counts[step] ?? 0) + 1;
    assert.equal(counts[step], 1, "Original model step repeated");
    await writeFile(join(config.directory, "provider-counts.json"), JSON.stringify(counts), {
      mode: 0o600,
    });
    return {
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      bytes: Buffer.from(
        JSON.stringify({
          id: "synthetic-browser-response",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: call ? "tool_calls" : "stop",
              message: { role: "assistant", content, ...(call ? { tool_calls: [call] } : {}) },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
        }),
      ),
    };
  };
  const options = entryOptions({
    ...process.env,
    OPENBOT_TS_PRODUCT_GROUP: "p3",
    OPENBOT_TS_WORK_GROUP: "p4",
    OPENBOT_TS_AUTH_GROUP: "owner",
    OPENBOT_TS_CHANNEL_READ_GROUP: "channels",
    OPENBOT_TS_READ_GROUP: "transcription",
    OPENBOT_TS_WRITE_GROUP: "primary-bot",
    OPENBOT_TS_DATABASE_URL: process.env.OPENBOT_CONTROL_DATABASE_URL,
    OPENBOT_TS_OWNER_PASSWORD: process.env.OPENBOT_CONTROL_OWNER_PASSWORD,
    OPENBOT_TS_PORT: process.env.OPENBOT_CONTROL_PORT,
    OPENBOT_TS_PUBLIC_ORIGIN: `http://127.0.0.1:${process.env.OPENBOT_CONTROL_PORT}`,
    OPENBOT_TS_PYTHON_ORIGIN: "http://127.0.0.1:1",
    OPENBOT_TS_OBJECT_ROOT: process.env.OPENBOT_CONTROL_OBJECT_ROOT,
    OPENBOT_TS_ARTIFACT_ROOT: process.env.OPENBOT_CONTROL_ARTIFACT_ROOT,
    OPENBOT_TS_MODEL_CONNECTION_KEY_PATH: join(directory, "model.key"),
    OPENBOT_TS_WORK_FILE_ROOT: join(directory, "work-files"),
  });
  assert.ok(options.product);
  options.product.modelTransport = transport;
  await runEntry(options);
}
