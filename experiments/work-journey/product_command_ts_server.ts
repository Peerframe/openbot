/** The production P4 entry with only model HTTP replaced; the command Node and Host transport stay real. */
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import proto from "@temporalio/proto";
import { Worker } from "@temporalio/worker";
import { entryOptions } from "../../apps/server-ts/src/config.js";
import { runEntry } from "../../apps/server-ts/src/lifetime.js";
import type { ModelTransport } from "../../apps/server-ts/src/model-network.js";
import { WorkCommandDispatches } from "../../apps/server-ts/src/work-command-dispatches.js";
import { WorkExecution } from "../../apps/server-ts/src/work-execution.js";

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
  assert.ok(process.env.OPENBOT_COMMAND_PROBE_CONFIG);
  const config = JSON.parse(await readFile(process.env.OPENBOT_COMMAND_PROBE_CONFIG, "utf8"));
  const directory = dirname(config.directory);
  const counts: Record<string, number> = {};
  const csv = "label,value\nalpha,12\nbeta,8\ngamma,5\n";
  const summary =
    "The supplied values 12, 8 and 5 total 25. The command output and report are attached.";
  const report =
    "# Synthetic command result\n\nThe supplied CSV contains 12, 8 and 5; their sum is **25**.\n";
  const transport: ModelTransport = async (request) => {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    assert.ok(request.body);
    const body = JSON.parse(request.body);
    assert.equal(body.model, "synthetic-command-model");
    const messages = body.messages as { role: string; content: string; tool_call_id?: string }[];
    const outputs = new Map(
      messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, JSON.parse(m.content)]),
    );
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
        proof.commandArtifacts.some(
          (r: { name: string; text: string }) => r.name === "result.csv" && r.text === csv,
        ),
      );
      assert.ok(
        proof.toolObservations.some(
          (o: { content: string }) => JSON.parse(o.content).exitCode === 0,
        ),
      );
      await writeFile(join(config.directory, "review.json"), JSON.stringify(proof), {
        mode: 0o600,
      });
      step = "review";
      content = JSON.stringify({
        accepted: true,
        reason: "Complete input, original command output and report agree.",
      });
    } else if (!outputs.has("command-copy")) {
      assert.ok(JSON.stringify(messages).includes("/input/input-01"));
      step = "command";
      tool("command-copy", "run_command", {
        argv: ["/bin/cp", "/input/input-01", "/output/result.csv"],
        output: { name: "result.csv", mediaType: "text/csv", maxBytes: 65536 },
      });
    } else if (!outputs.has("command-report")) {
      assert.equal(outputs.get("command-copy").exitCode, 0);
      assert.ok(JSON.stringify(outputs.get("command-copy")).includes("alpha"));
      step = "report";
      tool("command-report", "write_report", { name: "command-report.md", markdown: report });
    } else {
      step = "final";
      content = summary;
    }
    counts[step] = (counts[step] ?? 0) + 1;
    assert.equal(counts[step], 1, "Original model step repeated");
    await writeFile(join(config.directory, "provider-count.json"), JSON.stringify(counts), {
      mode: 0o600,
    });
    return {
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      bytes: Buffer.from(
        JSON.stringify({
          id: "synthetic-command-response",
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
  if (config.claimApprovalRace) {
    const claim = WorkExecution.prototype.claim;
    let held = false;
    WorkExecution.prototype.claim = async function (...args) {
      const fence = await claim.apply(this, args);
      const pending = await this.transactions.run(
        async (db) =>
          db`SELECT 1 FROM work_actions WHERE run_id=${fence.runId} AND status='proposed' AND decision='pending' AND intent->>'tool'='run_command'`,
      );
      if (!held && pending.length) {
        held = true;
        await writeFile(
          join(config.directory, "claim-before-approval"),
          "actual SDK claim retained",
          { mode: 0o600 },
        );
        const end = Date.now() + 15000;
        for (;;) {
          try {
            await access(join(config.directory, "owner-approved"));
            break;
          } catch {}
          assert.ok(Date.now() < end, "Original claim race fixture expired");
          await delay(10);
        }
      }
      return fence;
    };
  }
  const reserve = WorkCommandDispatches.prototype.reserve;
  WorkCommandDispatches.prototype.reserve = async function (...args) {
    try {
      return await reserve.apply(this, args);
    } catch (error) {
      const scope = args[0];
      const [facts] = await this.transactions.run(
        async (db) =>
          db`SELECT extract(epoch FROM (c.expires_at-clock_timestamp())) AS claim_seconds,extract(epoch FROM (a.expires_at-clock_timestamp())) AS action_seconds FROM work_claims c JOIN work_actions a ON a.run_id=c.run_id WHERE c.claim_id=${scope.fence.claimId} AND a.id=${args[1]}`,
      );
      await writeFile(
        join(config.directory, "execution-refusal.json"),
        JSON.stringify({
          name: error instanceof Error ? error.name : "Unknown",
          code:
            error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : null,
          facts,
        }),
        { mode: 0o600 },
      );
      throw error;
    }
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
