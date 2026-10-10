/** Stateful work-product contract scenarios used by the serial Vitest integration lane. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { Worker, type WorkflowBundle } from "@temporalio/worker";
import postgres from "postgres";
import { createEntry } from "../../apps/server/dist/app.js";
import type { EntryOptions } from "../../apps/server/dist/config.js";
import type { ModelTransport } from "../../apps/server/dist/model-network.js";
import { WorkLedger } from "../../apps/server/dist/work-ledger.js";
import {
  runProgressDetailsSchema,
  runSchema,
  workSnapshotWireSchema,
  workspaceSnapshotSchema,
} from "../../packages/protocol/dist/index.js";
import {
  assertEngineClosure,
  Client,
  Connection,
  observeEngineClosure,
  WORKFLOW_ID_PREFIX,
} from "../../packages/work/dist/index.js";
import { qualifyBrowserWork } from "./browser-work.ts";
import { commandArguments, commandWorkFixture } from "./command-work.ts";
import { workPluginFixture } from "../ts-work-plugin-fixture.ts";
import { workWebFixture } from "../ts-work-web-fixture.ts";
import { qualifyWorkerProduct } from "./worker-product.ts";

export async function qualifyWorkProduct(
  databaseUrl: string,
  fixture: {
    address: string;
    tls: { ca: string; certificate: string; key: string; server_name: string };
  },
  workflowBundle: WorkflowBundle,
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-work-product-"))),
    sql = postgres(databaseUrl, { max: 2 });
  let engineConnection: Connection | undefined;
  let app: Awaited<ReturnType<typeof createEntry>> | undefined;
  const pluginPeer = await workPluginFixture();
  let commandPeer: Awaited<ReturnType<typeof commandWorkFixture>> | undefined;
  let webPeer: Awaited<ReturnType<typeof workWebFixture>> | undefined;
  const calls = new Map<string, number>();
  const mediaRequests = new Map<string, unknown[][]>();
  let holdReview = false;
  let hold: string | undefined, release: (() => void) | undefined, reached: string | undefined;
  const transport: ModelTransport = async (request) => {
    const body = JSON.parse(request.body!),
      messages = body.messages;
    const input = JSON.parse(messages[1].content),
      objective = String(input.objective);
    const review = messages[0].content.startsWith("Independently review");
    if (objective.startsWith("Original media")) {
      const parts = messages.at(-1).content;
      assert.ok(Array.isArray(parts));
      const list = mediaRequests.get(objective) ?? [];
      list.push(parts.slice(1));
      mediaRequests.set(objective, list);
    }
    calls.set(objective, (calls.get(objective) ?? 0) + 1);
    if (hold === objective && (!holdReview || review)) {
      reached = objective;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    if (objective === "Lost response")
      throw new Error("Synthetic provider reply lost after observation");
    const answer = review
      ? JSON.stringify({
          accepted: !["Reject review", "Reject channel review"].includes(objective),
          reason: "Synthetic evidence reviewed",
        })
      : "Prepared the requested report.";
    const tools = messages
      .filter((m: { role: string }) => m.role === "tool")
      .map((m: { content: string }) => JSON.parse(m.content));
    const hasReport = tools.some(
      (t: { status?: string; publishedOnTaskCompletion?: boolean }) =>
        t.status === "prepared" && t.publishedOnTaskCompletion === true,
    );
    const shouldRead =
      !review &&
      input.attachments?.some((a: { mode: string }) => a.mode !== "binary") &&
      !tools.some((t: { attachmentId?: string }) => t.attachmentId);
    const knowledge =
      !review &&
      (!input.channel || objective.startsWith("Channel resources")) &&
      body.tools?.some(
        (t: { function: { name: string } }) => t.function.name === "knowledge_catalog",
      );
    const catalog = tools.find((t: { skills?: unknown[] }) => Array.isArray(t.skills));
    const knowledgeCall = !knowledge
      ? null
      : !catalog
        ? { name: "knowledge_catalog", arguments: {} }
        : catalog.skills.length && !tools.some((t: { markdown?: string }) => t.markdown)
          ? { name: "read_skill", arguments: { skillId: catalog.skills[0].id } }
          : !tools.some((t: { memories?: unknown[] }) => Array.isArray(t.memories))
            ? { name: "read_employee_memory", arguments: {} }
            : !tools.some((t: { requiresOwnerReview?: boolean }) => t.requiresOwnerReview)
              ? {
                  name: "propose_memory",
                  arguments: {
                    kind: "semantic",
                    title: "Fixture lesson",
                    content: "Only cite the supplied synthetic evidence.",
                  },
                }
              : null;
    const plugin =
      !review && (!input.channel || objective.startsWith("Channel resources")) && input.plugins;
    const pluginCall = !plugin
      ? null
      : !tools.some((t: { tool?: string }) => t.tool === "echo") && plugin.tools.length
        ? {
            name: "call_plugin",
            arguments: {
              pluginId: plugin.tools[0].pluginId,
              revision: plugin.tools[0].revision,
              toolName: plugin.tools[0].toolName,
              arguments: { text: "Synthetic task input" },
            },
          }
        : !tools.some((t: { kind?: string }) => t.kind === "resource") && plugin.resources.length
          ? {
              name: "read_plugin_resource",
              arguments: {
                pluginId: plugin.resources[0].pluginId,
                revision: plugin.resources[0].revision,
                name: plugin.resources[0].name,
              },
            }
          : null;
    const web =
      !review && (!input.channel || objective.startsWith("Channel resources")) && input.web;
    const webCall = !web
      ? null
      : objective.startsWith("Exhaust web calls")
        ? { name: "fetch", arguments: { url: "https://example.com/repeat" } }
        : !tools.some((t: { url?: string }) => t?.url === "https://example.com/evidence")
          ? { name: "read_public_page", arguments: { sourceIndex: 0 } }
          : !tools.some((t: { url?: string }) => t?.url === "https://example.com/extra")
            ? { name: "fetch", arguments: { url: "https://example.com/extra" } }
            : !tools.some((t: unknown) => typeof t === "string") && web.searchProvider
              ? { name: "web_search", arguments: { query: "Synthetic evidence" } }
              : null;
    const colleagueCall =
      !review &&
      input.collaborators?.length &&
      objective.startsWith("Collaboration root") &&
      !input.corrections?.length &&
      !tools.some((t: { runId?: string }) => typeof t.runId === "string")
        ? {
            name: objective.includes("delegate") ? "delegate_task" : "start_task",
            arguments: {
              botId: objective.endsWith("ungranted")
                ? "11111111-1111-4111-8111-111111111111"
                : input.collaborators[0],
              task: objective.replace("root", "child"),
            },
          }
        : null;
    const channelCall =
      review || !input.channel
        ? null
        : !tools.some(
              (t: unknown) => Array.isArray(t) && t.some((v) => v && typeof v.id === "string"),
            )
          ? { name: "read_channel_context", arguments: {} }
          : !tools.some(
                (t: unknown) => Array.isArray(t) && t.some((v) => v && typeof v.title === "string"),
              )
            ? { name: "read_task_status", arguments: {} }
            : !tools.some((t: { bots?: unknown[] }) => Array.isArray(t?.bots))
              ? { name: "list_channel_bots", arguments: {} }
              : null;
    const browserTask = objective.startsWith("Browser Task"),
      browserObservations = tools.filter((t: { status?: string }) => t.status === "observed"),
      lastPage = browserObservations.at(-1);
    if (browserTask && !review) {
      const names = body.tools.map((t: { function: { name: string } }) => t.function.name);
      for (const forbidden of ["call_plugin", "delegate_task", "knowledge_catalog", "search_web"])
        assert(!names.includes(forbidden), "Browser source cannot gain " + forbidden);
    }
    const browserCall =
      review || !browserTask
        ? null
        : objective === "Browser Task redirect"
          ? !lastPage
            ? { name: "navigate_browser", arguments: { url: "https://fixture.invalid/worker" } }
            : null
          : !tools.some((t: { status?: string }) => t.status === "captured")
            ? { name: "capture_browser", arguments: {} }
            : objective !== "Browser Task complete"
              ? null
              : browserObservations.length === 0
                ? { name: "navigate_browser", arguments: { url: "https://fixture.invalid/worker" } }
                : browserObservations.length === 1
                  ? {
                      name: "type_browser",
                      arguments: {
                        observationId: lastPage.observationId,
                        ref: "e1",
                        text: "Approved fixture",
                      },
                    }
                  : browserObservations.length === 2
                    ? { name: "read_browser", arguments: {} }
                    : null;
    const commandCall =
      !review &&
      objective.startsWith("Command Task") &&
      !tools.some((t: { status?: string }) => t.status === "exited");
    if (objective.startsWith("Command Task")) {
      if (review) {
        assert.equal(input.commandArtifacts.length, 1);
        assert.equal(input.commandArtifacts[0].text, "label,value\nalpha,12\nbeta,8\ngamma,5\n");
      } else {
        assert(input.command?.requiresOwnerApproval);
        assert(
          !body.tools.some((t: { function: { name: string } }) =>
            ["call_plugin", "web_search", "create_task", "knowledge_catalog"].includes(
              t.function.name,
            ),
          ),
        );
      }
    }
    const message = commandCall
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "command-call",
              type: "function",
              function: { name: "run_command", arguments: JSON.stringify(commandArguments) },
            },
          ],
        }
      : browserCall
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "browser-" + tools.length,
                type: "function",
                function: {
                  name: browserCall.name,
                  arguments: JSON.stringify(browserCall.arguments),
                },
              },
            ],
          }
        : channelCall
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "channel-" + channelCall.name,
                  type: "function",
                  function: { name: channelCall.name, arguments: "{}" },
                },
              ],
            }
          : colleagueCall
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "colleague-call",
                    type: "function",
                    function: {
                      name: colleagueCall.name,
                      arguments: JSON.stringify(colleagueCall.arguments),
                    },
                  },
                ],
              }
            : webCall
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "web-" + webCall.name + "-" + tools.length,
                      type: "function",
                      function: {
                        name: webCall.name,
                        arguments: JSON.stringify(webCall.arguments),
                      },
                    },
                  ],
                }
              : pluginCall
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "plugin-" + pluginCall.name,
                        type: "function",
                        function: {
                          name: pluginCall.name,
                          arguments: JSON.stringify(pluginCall.arguments),
                        },
                      },
                    ],
                  }
                : knowledgeCall
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "knowledge-" + knowledgeCall.name,
                          type: "function",
                          function: {
                            name: knowledgeCall.name,
                            arguments: JSON.stringify(knowledgeCall.arguments),
                          },
                        },
                      ],
                    }
                  : shouldRead
                    ? {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: "attachment-call",
                            type: "function",
                            function: {
                              name: "read_attachment",
                              arguments: JSON.stringify({
                                attachmentId: input.attachments.find(
                                  (a: { mode: string }) => a.mode !== "binary",
                                ).id,
                              }),
                            },
                          },
                        ],
                      }
                    : !review && !hasReport
                      ? {
                          role: "assistant",
                          content: null,
                          tool_calls: [
                            {
                              id: "report-call",
                              type: "function",
                              function: {
                                name: "write_report",
                                arguments: JSON.stringify({
                                  name: "Report.md",
                                  markdown: "# Synthetic report\n\n" + objective,
                                }),
                              },
                            },
                          ],
                        }
                      : { role: "assistant", content: answer };
    const bytes = Buffer.from(
      JSON.stringify({
        id: "synthetic-completion",
        object: "chat.completion",
        created: 1,
        model: "synthetic-model",
        choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      }),
    );
    return { status: 200, headers: new Headers({ "Content-Type": "application/json" }), bytes };
  };
  try {
    webPeer = await workWebFixture();
    commandPeer = await commandWorkFixture();
    const files = join(directory, "work");
    await mkdir(files, { mode: 0o700 });
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`,
      token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    await sql`INSERT INTO auth_sessions(id,token_digest,owner_id,expires_at) VALUES(${randomUUID()},${hash},'owner',clock_timestamp()+interval '10 minutes')`;
    const browserBot = randomUUID(),
      workerNode = "p4-worker-" + randomUUID();
    await sql`INSERT INTO bots(id,name,role,computer_profile) VALUES(${browserBot},'Worker fixture','Synthetic browser acceptance','docker-linux')`;
    const options: EntryOptions = {
      host: "127.0.0.1",
      port,
      publicOrigin: origin,
      channelRead: { databaseUrl },
      product: {
        databaseUrl,
        controlReads: true,
        workerRuntime: {
          command: commandPeer.configPath,
          browserRoutes: { [browserBot]: workerNode },
          pageOrigins: { [browserBot]: ["https://fixture.invalid"] },
          humanControl: true,
          legacyHumanControl: false,
        },
        plugins: {
          storePath: join(directory, "plugins", "state.json"),
          localEndpoints: [pluginPeer.endpoint],
        },
        files: { objectRoot: join(directory, "objects") },
        models: { keyPath: join(directory, "model.key"), customBaseUrls: [] },
        modelTransport: transport,
        work: {
          tokenLimit: 1000000,
          web: { client: webPeer.client, tavilyKey: randomBytes(24).toString("hex") },
          address: fixture.address,
          namespace: "default",
          taskQueue: "openbot-work-ts-v1-" + randomUUID(),
          executionTimeoutMs: 300000,
          fileRoot: files,
          tls: {
            ca: fixture.tls.ca,
            certificate: fixture.tls.certificate,
            key: fixture.tls.key,
            serverName: fixture.tls.server_name,
          },
        },
      },
    };
    engineConnection = await Connection.connect({
      address: fixture.address,
      connectTimeout: 10000,
      tls: {
        serverNameOverride: fixture.tls.server_name,
        serverRootCACertificate: await readFile(fixture.tls.ca),
        clientCertPair: {
          crt: await readFile(fixture.tls.certificate),
          key: await readFile(fixture.tls.key),
        },
      },
    });
    const engineClient = new Client({ connection: engineConnection, namespace: "default" });
    const start = async () => {
      app = await createEntry(options);
      await app.listen({ host: "127.0.0.1", port });
    };
    await start();
    const request = (path: string, method = "GET", body?: unknown, authenticated = true) =>
      fetch(origin + path, {
        method,
        headers: {
          Origin: origin,
          ...(authenticated ? { Cookie: "openbot_session=" + token } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
    const connection = await request("/api/v1/model-connections", "POST", {
      name: "Synthetic Work provider",
      presetId: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: randomBytes(24).toString("hex"),
      defaultModel: "synthetic-model",
    });
    assert.equal(connection.status, 201, await connection.clone().text());
    const created = (await connection.json()) as { connection: { id: string } };
    // Exercise the same channel submission and projections consumed by Web. Each refusal
    // happens before a model Action is admitted; an uncertain dispatch stays unknown instead.
    const failureChannel = randomUUID();
    await sql`INSERT INTO channels(id,name) VALUES(${failureChannel},'Failure projection fixture')`;
    const disabledResponse = await request("/api/v1/model-connections", "POST", {
      name: "Disabled fixture provider",
      presetId: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: randomBytes(24).toString("hex"),
      defaultModel: "synthetic-model",
    });
    assert.equal(disabledResponse.status, 201, await disabledResponse.clone().text());
    const disabledModel = (await disabledResponse.json()) as {
      connection: { id: string; revision: number };
    };
    const disable = await request(
      `/api/v1/model-connections/${disabledModel.connection.id}`,
      "PATCH",
      {
        expectedRevision: disabledModel.connection.revision,
        enabled: false,
      },
    );
    assert.equal(disable.status, 200, await disable.clone().text());
    const [preferences] =
      await sql`SELECT default_model FROM owner_preferences WHERE owner_id='owner'`;
    assert.equal(preferences!.default_model, null);
    for (const [objective, connectionId] of [
      ["Missing model selection", null],
      ["Disabled model selection", disabledModel.connection.id],
      ["Missing model connection", randomUUID()],
      ["Reject channel review", created.connection.id],
    ] as const) {
      const failureBot = randomUUID();
      await sql`INSERT INTO bots(id,name,role,computer_profile,configuration) VALUES(${failureBot},${objective},'Synthetic acceptance','model',
        ${sql.json(connectionId === null ? {} : { model: { connectionId, modelId: "synthetic-model" } })}::jsonb)`;
      await sql`INSERT INTO channel_bots(channel_id,bot_id) VALUES(${failureChannel},${failureBot})`;
      const submitted = await request(`/api/v1/channels/${failureChannel}/messages`, "POST", {
        content: objective,
        botId: failureBot,
      });
      assert.equal(submitted.status, 201, await submitted.clone().text());
      const { run } = (await submitted.json()) as { run: { id: string; workTaskId: string } };
      const task = await until(
        async () => {
          const response = await request(`/api/v1/tasks/${run.workTaskId}`);
          assert.equal(response.status, 200);
          return workSnapshotWireSchema.parse(await response.json());
        },
        (value) => value.status === "failed",
      );
      const generic = objective === "Reject channel review";
      const expectedCode = generic ? "task_failed" : "model_unavailable";
      const expectedMessage = generic
        ? "Task execution failed."
        : "No usable model is configured for this task. Check the Bot model and enabled connection in Settings.";
      const listed = await request(`/api/v1/channels/${failureChannel}/runs`);
      assert.equal(listed.status, 200, await listed.clone().text());
      const runs = (await listed.json()) as { runs: unknown[] };
      const projected = runs.runs
        .map((value) => runSchema.parse(value))
        .find((value) => value.id === run.id)!;
      assert.equal(projected.errorCode, expectedCode);
      assert.equal(projected.errorMessage, expectedMessage);
      const progressResponse = await request(`/api/v1/runs/${run.id}/progress`);
      assert.equal(progressResponse.status, 200);
      assert.equal(
        runProgressDetailsSchema.parse(await progressResponse.json()).failureReasonCode,
        expectedCode,
      );
      const workspace = await request("/api/v1/workspace");
      assert.equal(workspace.status, 200);
      const view = workspaceSnapshotSchema.parse(await workspace.json());
      assert.equal(view.runs.find((value) => value.id === run.id)!.errorCode, expectedCode);
      assert.equal(view.runProgress[run.id]!.failureReasonCode, expectedCode);
      const failed = task.events.filter((event) => event.kind === "task.failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.payload.publicCode, expectedCode);
      assert.equal(task.artifacts.length, 0);
      if (!generic) {
        assert.equal(failed[0]!.payload.reason, "product_model_unconfigured");
        assert.equal(task.actions.length, 0);
        assert.equal(calls.get(objective), undefined);
      } else assert.equal(failed[0]!.payload.reason, "result_review_refused");
      const handle = engineClient.workflow.getHandle(WORKFLOW_ID_PREFIX + task.runs[0]!.id);
      await handle.result();
      await Worker.runReplayHistory({ workflowBundle }, await handle.fetchHistory());
      console.log(
        `PASS actual channel ${objective}: ${expectedCode} in Runs/workspace/progress, safe message, no publication and history replay`,
      );
    }
    const browserChannel = randomUUID();
    await sql`UPDATE bots SET configuration=${sql.json({ model: { connectionId: created.connection.id, modelId: "synthetic-model" } })} WHERE id=${browserBot}`;
    await sql`INSERT INTO channels(id,name) VALUES(${browserChannel},'Browser Work fixture')`;
    await sql`INSERT INTO channel_bots(channel_id,bot_id) VALUES(${browserChannel},${browserBot})`;
    await qualifyWorkerProduct(origin, token, browserBot, workerNode, (context) =>
      qualifyBrowserWork(context, browserBot, browserChannel),
    );
    const commandResult = await commandPeer.exercise(origin, token, created.connection.id);
    assert.equal(
      (
        await sql`SELECT 1 FROM work_events WHERE task_id=${commandResult.taskId} AND kind='command.permit_issued'`
      ).length,
      1,
    );
    for (const taskId of [commandResult.taskId, commandResult.lostTaskId]) {
      assert.equal(
        (await sql`SELECT 1 FROM work_command_preparations WHERE task_id=${taskId}`).length,
        1,
      );
      assert.equal(
        (
          await sql`SELECT 1 FROM work_command_dispatches WHERE task_id=${taskId} AND state='consumed'`
        ).length,
        1,
      );
      assert.equal(
        (
          await sql`SELECT 1 FROM work_events WHERE task_id=${taskId} AND kind='command.permit_issued'`
        ).length,
        1,
      );
    }
    assert.equal(
      (
        await sql`SELECT 1 FROM work_command_preparations WHERE task_id=${commandResult.deniedTaskId}`
      ).length,
      0,
    );
    const botId = randomUUID();
    await sql`INSERT INTO bots(id,name,role,computer_profile,configuration) VALUES(${botId},'Work fixture','Synthetic acceptance','model',
      ${sql.json({ model: { connectionId: created.connection.id, modelId: "synthetic-model" } })}::jsonb)`;
    const create = async (objective: string, scope?: unknown) => {
      const body = {
        botId,
        objective,
        tokenLimit: 1000000,
        requestKey: randomUUID(),
        ...(scope ? { scope } : {}),
      };
      const response = await request("/api/v1/tasks", "POST", body);
      assert.equal(response.status, 202, await response.clone().text());
      return { body, task: workSnapshotWireSchema.parse(await response.json()) };
    };
    const snapshot = async (id: string) => {
      const response = await request("/api/v1/tasks/" + id);
      if (response.status !== 200) {
        const activity = await sql`SELECT application_name,state,wait_event_type,wait_event,
          left(query,250) AS query,pg_blocking_pids(pid) AS blockers
          FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`;
        console.error("Owned synthetic database contention", JSON.stringify(activity));
      }
      assert.equal(response.status, 200, await response.clone().text());
      const task = workSnapshotWireSchema.parse(await response.json());
      if (
        task.events.some(
          (e) =>
            e.kind === "task.failed" &&
            e.payload.reason === "engine_terminal" &&
            e.payload.publicCode === "engine_failed",
        )
      ) {
        const history = await engineClient.workflow
          .getHandle(WORKFLOW_ID_PREFIX + task.runs[0]!.id)
          .fetchHistory();
        const failures = history.events?.flatMap((e) =>
          e.activityTaskFailedEventAttributes
            ? [{ kind: "activity", failure: e.activityTaskFailedEventAttributes.failure }]
            : e.activityTaskTimedOutEventAttributes
              ? [
                  {
                    kind: "activity_timeout",
                    failure: e.activityTaskTimedOutEventAttributes.failure,
                  },
                ]
              : e.workflowExecutionFailedEventAttributes
                ? [{ kind: "workflow", failure: e.workflowExecutionFailedEventAttributes.failure }]
                : [],
        );
        console.error("Owned fixture engine failures", JSON.stringify(failures));
      }
      return task;
    };
    async function until<T>(
      read: () => Promise<T>,
      done: (value: T) => boolean,
      milliseconds = 40000,
    ): Promise<T> {
      const end = Date.now() + milliseconds;
      let value: T;
      do {
        value = await read();
        if (done(value)) return value;
        await delay(100);
      } while (Date.now() < end);
      assert.fail("Work product did not reach expected state: " + JSON.stringify(value));
    }
    assert.equal((await request("/api/v1/tasks", "POST", {}, false)).status, 401);
    const success = await create("Publish report"),
      completed = await until(
        () => snapshot(success.task.id),
        (t) => ["completed", "failed"].includes(t.status),
      );
    assert.equal(completed.status, "completed", JSON.stringify(completed));
    assert.equal(completed.artifacts.length, 1);
    assert.equal(completed.usage.spentTokens, 600);
    assert.equal(completed.usage.reservedTokens, 0);
    assert.equal(calls.get("Publish report"), 3);
    const bytes = await request(completed.artifacts[0]!.downloadUrl);
    assert.equal(bytes.status, 200);
    assert.equal(await bytes.text(), "# Synthetic report\n\nPublish report");
    const replay = await request("/api/v1/tasks", "POST", success.body);
    assert.equal(replay.status, 202);
    assert.equal(((await replay.json()) as { id: string }).id, success.task.id);
    assert.equal(calls.get("Publish report"), 3);
    console.log(
      "PASS real HTTP -> TS Temporal Worker -> official model SDK -> report -> independent review -> atomic publication/download; idempotent replay",
    );

    const rejected = await create("Reject review"),
      refused = await until(
        () => snapshot(rejected.task.id),
        (t) => t.status === "failed",
      );
    assert.equal(refused.artifacts.length, 0);
    assert.equal(refused.resultSummary, null);
    assert.equal(calls.get("Reject review"), 3);
    console.log("PASS review refusal publishes neither summary nor prepared report");

    hold = "Cancel during response";
    const cancelled = await create(hold);
    await until(
      async () => reached,
      (r) => r === hold,
    );
    const cancel = await request(`/api/v1/tasks/${cancelled.task.id}/cancel`, "POST", {});
    assert.equal(cancel.status, 200);
    hold = undefined;
    release!();
    const closed = await until(
      () => snapshot(cancelled.task.id),
      (t) => t.status === "cancelled",
    );
    assert.equal(closed.artifacts.length, 0);
    assert.equal(closed.actions.filter((a) => a.status === "applied").length, 1);
    assert.equal(calls.get("Cancel during response"), 1);
    console.log(
      "PASS cancellation after model dispatch preserves observed billing without executing tools or publishing",
    );

    const upload = await fetch(origin + "/api/v1/task-attachments", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: "openbot_session=" + token,
        "Content-Type": "application/octet-stream",
        "X-OpenBot-Filename": "Evidence.txt",
      },
      body: "Synthetic scoped evidence 😀",
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(upload.status, 201, await upload.clone().text());
    const attachment = ((await upload.json()) as { attachment: { id: string } }).attachment;
    const resourceScope = {
      version: 1,
      attachmentIds: [attachment.id],
      collaboratorBotIds: [],
      knowledge: false,
      plugins: false,
      web: false,
    };
    const policy = await request("/api/v1/settings/approvals"),
      policyValue = (await policy.json()) as { revision: number };
    const updatedPolicy = await request("/api/v1/settings/approvals", "PUT", {
      expectedRevision: policyValue.revision,
      productRead: "required",
      publicWeb: "inherit",
      exceptions: [],
    });
    assert.equal(updatedPolicy.status, 200, await updatedPolicy.clone().text());
    const reading = await create("Read scoped attachment", resourceScope);
    const waiting = await until(
      () => snapshot(reading.task.id),
      (t) => t.actions.some((a) => a.decision === "pending"),
    );
    const readAction = waiting.actions.find((a) => a.decision === "pending")!;
    assert.equal(readAction.status, "proposed");
    assert.equal(calls.get("Read scoped attachment"), 1);
    const approval = await request(`/api/v1/actions/${readAction.id}/decision`, "POST", {
      intentDigest: readAction.intentDigest,
      approved: true,
    });
    assert.equal(approval.status, 200, await approval.clone().text());
    const readDone = await until(
      () => snapshot(reading.task.id),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(readDone.status, "completed", JSON.stringify(readDone));
    assert.equal(readDone.artifacts.length, 1);
    assert.equal(calls.get("Read scoped attachment"), 4);
    assert.equal(readDone.actions.find((a) => a.id === readAction.id)?.status, "applied");
    console.log(
      "PASS HTTP Owner attachment scope -> required approval -> durable text read -> model continuation -> independent review/publication",
    );
    const resetPolicy = await request("/api/v1/settings/approvals", "PUT", {
      expectedRevision: policyValue.revision + 1,
      productRead: "inherit",
      publicWeb: "inherit",
      exceptions: [],
    });
    assert.equal(resetPolicy.status, 200);
    hold = "Revoke attachment before publication";
    holdReview = true;
    reached = undefined;
    const revoked = await create(hold, resourceScope);
    await until(
      async () => reached,
      (r) => r === hold,
    );
    assert.equal(
      (await request(`/api/v1/task-attachments/${attachment.id}`, "DELETE", {})).status,
      200,
    );
    hold = undefined;
    holdReview = false;
    release!();
    const revokedDone = await until(
      () => snapshot(revoked.task.id),
      (t) => t.status === "failed",
    );
    assert.equal(revokedDone.artifacts.length, 0);
    assert.equal(revokedDone.resultSummary, null);
    assert(
      revokedDone.actions.some(
        (a) => a.intent.tool === "read_attachment" && a.status === "applied",
      ),
    );
    console.log(
      "PASS attachment revocation while review response is in flight prevents publication without erasing observed usage",
    );

    const mediaFixtures = JSON.parse(
      await readFile(
        new URL("../../apps/server/tests/fixtures/retained-media-wire.json", import.meta.url),
        "utf8",
      ),
    )[1].projection as { mediaType: string; data: string; name: string | null }[];
    const mediaIds: string[] = [];
    for (const [index, item] of mediaFixtures.entries()) {
      const name = item.name ?? `original${index}.${index === 0 ? "png" : "jpg"}`;
      const upload = await fetch(origin + "/api/v1/task-attachments", {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: "openbot_session=" + token,
          "Content-Type": "application/octet-stream",
          "X-OpenBot-Filename": encodeURIComponent(name),
        },
        body: Buffer.from(item.data, "base64"),
      });
      assert.equal(upload.status, 201, await upload.clone().text());
      mediaIds.push(((await upload.json()) as { attachment: { id: string } }).attachment.id);
    }
    const mediaScope = { ...resourceScope, attachmentIds: mediaIds };
    const mediaTask = await create("Original media report", mediaScope);
    const mediaDone = await until(
      () => snapshot(mediaTask.task.id),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(mediaDone.status, "completed", JSON.stringify(mediaDone));
    const wires = mediaRequests.get("Original media report")!;
    assert.equal(wires.length, 3);
    for (const parts of wires) {
      const projection = (parts as any[]).map((part) => ({
        mediaType: (part.file?.file_data ?? part.image_url.url).slice(5).split(";")[0],
        data: (part.file?.file_data ?? part.image_url.url).split(",")[1],
        name: part.file?.filename ?? null,
      }));
      assert.deepEqual(
        projection,
        mediaIds
          .map((id, index) => ({ id, item: mediaFixtures[index] }))
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((value) => value.item),
      );
    }
    const anchors = mediaDone.events.filter((e) => e.kind === "model.media_bound");
    assert.equal(anchors.length, 1);
    for (const action of mediaDone.actions.filter((a) => a.intent.kind === "model"))
      assert.deepEqual(action.intent.inputMedia, anchors[0]!.payload.inputMedia);
    await engineClient.workflow.getHandle(WORKFLOW_ID_PREFIX + mediaDone.runs[0]!.id).result();
    const mediaHistory = await engineClient.workflow
      .getHandle(WORKFLOW_ID_PREFIX + mediaDone.runs[0]!.id)
      .fetchHistory();
    const historyWire = JSON.stringify(mediaHistory);
    for (const item of mediaFixtures) assert.equal(historyWire.includes(item.data), false);
    await Worker.runReplayHistory({ workflowBundle }, mediaHistory);
    hold = "Original media revoked during review";
    holdReview = true;
    reached = undefined;
    release = undefined;
    const revokeMedia = await create(hold, mediaScope);
    await until(
      async () => reached,
      (v) => v === hold,
    );
    assert.equal(
      (await request(`/api/v1/task-attachments/${mediaIds[0]}`, "DELETE", {})).status,
      200,
    );
    hold = undefined;
    holdReview = false;
    release!();
    const mediaRevoked = await until(
      () => snapshot(revokeMedia.task.id),
      (t) => t.status === "failed",
    );
    assert.equal(mediaRevoked.artifacts.length, 0);
    assert.ok(mediaRevoked.usage.spentTokens > 0);
    console.log(
      "PASS original PNG/JPEG/PDF bytes and retained names reach producer/reviewer through real Work; one immutable manifest, offline replay, no media in engine history and live revocation blocks publication",
    );

    const imported = await request(`/api/v1/bots/${botId}/skills/import`, "POST", {
      markdown:
        "---\nname: scoped-evidence\ndescription: Cite the supplied evidence.\n---\n\nUse only the supplied synthetic facts.\n",
      version: "1.0.0",
      reason: "Synthetic knowledge qualification",
    });
    assert.equal(imported.status, 201, await imported.clone().text());
    const importedValue = (await imported.json()) as {
      skill: { id: string; contentSha256: string };
    };
    const skillId = importedValue.skill.id;
    const verified = await request(`/api/v1/bots/${botId}/skills/${skillId}/state`, "POST", {
      state: "verified",
      reviewedContentSha256: importedValue.skill.contentSha256,
      confidence: 90,
      reason: "Reviewed synthetic fixture",
      ownerReviewed: true,
    });
    assert.equal(verified.status, 200, await verified.clone().text());
    const memory = await request(`/api/v1/bots/${botId}/memories`, "POST", {
      kind: "semantic",
      title: "Synthetic fact",
      content: "This qualification uses only synthetic local evidence.",
      sensitivity: "internal",
      portability: "never",
      modelUseEnabled: true,
    });
    assert.equal(memory.status, 201, await memory.clone().text());
    const knowledgeScope = {
      version: 1,
      attachmentIds: [],
      collaboratorBotIds: [],
      knowledge: true,
      plugins: false,
      web: false,
    };
    const learned = await create("Read knowledge and prepare lesson", knowledgeScope);
    const learnedDone = await until(
      () => snapshot(learned.task.id),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(learnedDone.status, "completed", JSON.stringify(learnedDone));
    assert.equal(learnedDone.artifacts.length, 1);
    const [proposalCount] =
      await sql`SELECT count(*) AS n FROM knowledge_proposals p JOIN work_runs r ON r.id=p.source_work_run_id WHERE r.task_id=${learned.task.id} AND p.status='pending'`;
    assert.equal(Number(proposalCount!.n), 1);
    const [memoryCount] =
      await sql`SELECT count(*) AS n FROM employee_memories WHERE bot_id=${botId}`;
    assert.equal(Number(memoryCount!.n), 1, "Task proposal must not activate a memory");
    console.log(
      "PASS reviewed skill catalog/read and Owner-enabled memory enter real model history; verified completion creates exactly one pending proposal and no active memory",
    );
    hold = "Revoke skill before publication";
    holdReview = true;
    reached = undefined;
    const revokedKnowledge = await create(hold, knowledgeScope);
    await until(
      async () => reached,
      (r) => r === hold,
    );
    const suspended = await request(`/api/v1/bots/${botId}/skills/${skillId}/state`, "POST", {
      state: "suspended",
      reason: "Synthetic revocation race",
      ownerReviewed: true,
    });
    assert.equal(suspended.status, 200, await suspended.clone().text());
    hold = undefined;
    holdReview = false;
    release!();
    const refusedKnowledge = await until(
      () => snapshot(revokedKnowledge.task.id),
      (t) => t.status === "failed",
    );
    assert.equal(refusedKnowledge.artifacts.length, 0);
    const [refusedCount] =
      await sql`SELECT count(*) AS n FROM knowledge_proposals p JOIN work_runs r ON r.id=p.source_work_run_id WHERE r.task_id=${revokedKnowledge.task.id}`;
    assert.equal(Number(refusedCount!.n), 0);
    console.log(
      "PASS live skill revocation vetoes prepared report and knowledge proposal publication",
    );

    const endpoint = { name: "Work fixture", endpoint: pluginPeer.endpoint };
    const preview = await request("/api/v1/plugins/preview", "POST", endpoint);
    assert.equal(preview.status, 200, await preview.clone().text());
    const manifest = (await preview.json()) as { digest: string };
    const installation = await request("/api/v1/plugins", "POST", {
      ...endpoint,
      reviewedDigest: manifest.digest,
    });
    assert.equal(installation.status, 201, await installation.clone().text());
    let installed = ((await installation.json()) as { plugin: { id: string; revision: string } })
      .plugin;
    const enable = await request(`/api/v1/plugins/${installed.id}`, "PATCH", {
      revision: installed.revision,
      enabled: true,
    });
    assert.equal(enable.status, 200, await enable.clone().text());
    installed = ((await enable.json()) as { plugin: typeof installed }).plugin;
    const grantPlugin = async (mode: "read" | "confirm") => {
      const granted = await request(`/api/v1/plugins/${installed.id}/grants/${botId}`, "PUT", {
        revision: installed.revision,
        tools: [{ name: "echo", mode }],
        resources: ["fixture://evidence"],
        prompts: [],
      });
      assert.equal(granted.status, 200, await granted.clone().text());
      installed = ((await granted.json()) as { plugin: typeof installed }).plugin;
    };
    const pluginScope = {
      version: 1,
      attachmentIds: [],
      collaboratorBotIds: [],
      knowledge: false,
      plugins: true,
      web: false,
    };
    await grantPlugin("read");
    const readPlugin = await create("Read plugin evidence", pluginScope);
    const pluginReadDone = await until(
      () => snapshot(readPlugin.task.id),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(pluginReadDone.status, "completed", JSON.stringify(pluginReadDone));
    assert.equal(
      pluginReadDone.actions.filter(
        (a) =>
          ["call_plugin", "read_plugin_resource"].includes(String(a.intent.tool)) &&
          a.status === "applied" &&
          a.decision === "not_required",
      ).length,
      2,
    );
    assert.deepEqual(pluginPeer.counts(), { calls: 1, reads: 1 });
    await grantPlugin("confirm");
    const confirmPlugin = await create("Confirm plugin evidence", pluginScope);
    const awaiting = await until(
      () => snapshot(confirmPlugin.task.id),
      (t) => t.actions.some((a) => a.decision === "pending") || t.status === "failed",
    );
    const proposed = awaiting.actions.find((a) => a.decision === "pending");
    assert(proposed, JSON.stringify(awaiting));
    assert.deepEqual(pluginPeer.counts(), { calls: 1, reads: 1 });
    const pluginApproval = await request(`/api/v1/actions/${proposed.id}/decision`, "POST", {
      intentDigest: proposed.intentDigest,
      approved: true,
    });
    assert.equal(pluginApproval.status, 200, await pluginApproval.clone().text());
    const confirmed = await until(
      () => snapshot(confirmPlugin.task.id),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(confirmed.status, "completed", JSON.stringify(confirmed));
    assert.deepEqual(pluginPeer.counts(), { calls: 2, reads: 2 });
    console.log(
      "PASS public plugin install/grant -> real MCP read and confirm Actions -> tool/resource observations -> reviewed publication; no second approval for read grants",
    );
    await grantPlugin("read");
    const closeMcp = McpClient.prototype.close;
    let cleanupFailures = 0;
    McpClient.prototype.close = async function () {
      await closeMcp.call(this);
      cleanupFailures++;
      throw new Error("Synthetic post-response SDK cleanup failure");
    };
    try {
      const cleanup = await create("Plugin cleanup failure", pluginScope);
      const preserved = await until(
        () => snapshot(cleanup.task.id),
        (t) => ["completed", "failed"].includes(t.status),
      );
      assert.equal(preserved.status, "completed", JSON.stringify(preserved));
      assert.equal(
        preserved.actions.filter(
          (a) =>
            ["call_plugin", "read_plugin_resource"].includes(String(a.intent.tool)) &&
            a.status === "applied",
        ).length,
        2,
      );
      assert.equal(cleanupFailures, 2);
    } finally {
      McpClient.prototype.close = closeMcp;
    }
    console.log(
      "PASS real MCP tool/resource observations survive injected SDK close failure without repeating a call",
    );
    hold = "Revoke plugin before publication";
    holdReview = true;
    reached = undefined;
    const revokePlugin = await create(hold, pluginScope);
    await until(
      async () => reached,
      (r) => r === hold,
    );
    const disabled = await request(`/api/v1/plugins/${installed.id}`, "PATCH", {
      revision: installed.revision,
      enabled: false,
    });
    assert.equal(disabled.status, 200, await disabled.clone().text());
    installed = ((await disabled.json()) as { plugin: typeof installed }).plugin;
    hold = undefined;
    holdReview = false;
    release!();
    const revokedPlugin = await until(
      () => snapshot(revokePlugin.task.id),
      (t) => t.status === "failed",
    );
    assert.equal(revokedPlugin.artifacts.length, 0);
    console.log(
      "PASS plugin revocation while independent review is in flight blocks publication, preserving observed results",
    );
    const reenabled = await request(`/api/v1/plugins/${installed.id}`, "PATCH", {
      revision: installed.revision,
      enabled: true,
    });
    assert.equal(reenabled.status, 200, await reenabled.clone().text());
    installed = ((await reenabled.json()) as { plugin: typeof installed }).plugin;
    pluginPeer.loseReply();
    const pluginLost = await create("Lost plugin reply", pluginScope);
    const unknownPlugin = await until(
      () => snapshot(pluginLost.task.id),
      (t) => t.actions.some((a) => a.status === "unknown") || t.status === "failed",
    );
    const pluginAction = unknownPlugin.actions.find(
      (a) => a.intent.tool === "call_plugin" && a.status === "unknown",
    );
    assert(pluginAction, JSON.stringify(unknownPlugin));
    const sent = pluginPeer.counts();
    const pluginRepair = await request(`/api/v1/actions/${pluginAction.id}/reconcile`, "POST", {
      intentDigest: pluginAction.intentDigest,
      requestKey: randomUUID(),
      expectedSequence: 0,
      reason: "Lookup original plugin receipt",
    });
    assert.equal(pluginRepair.status, 202, await pluginRepair.clone().text());
    await until(
      () => snapshot(pluginLost.task.id),
      (t) => t.actions.some((a) => a.reconciliation?.outcome === "unresolved"),
    );
    assert.deepEqual(pluginPeer.counts(), sent);
    assert.equal((await snapshot(pluginLost.task.id)).artifacts.length, 0);
    console.log(
      "PASS dropped real MCP reply remains unknown; Owner reconciliation never reconnects or resends",
    );

    pluginPeer.restoreReplies();

    const webScope = {
      version: 1,
      attachmentIds: [],
      collaboratorBotIds: [],
      knowledge: false,
      plugins: false,
      web: true,
    };
    const webPolicy = (await (await request("/api/v1/settings/approvals")).json()) as {
      revision: number;
    };
    assert.equal(
      (
        await request("/api/v1/settings/approvals", "PUT", {
          expectedRevision: webPolicy.revision,
          productRead: "inherit",
          publicWeb: "required",
          exceptions: [],
        })
      ).status,
      200,
    );
    const researched = await create("Read web evidence https://example.com/evidence", webScope);
    let approvedWeb = 0;
    while (approvedWeb < 3) {
      const pendingWeb = await until(
        () => snapshot(researched.task.id),
        (t) => t.status === "failed" || t.actions.some((a) => a.decision === "pending"),
      );
      const action = pendingWeb.actions.find((a) => a.decision === "pending");
      assert(action, JSON.stringify(pendingWeb));
      assert.equal(webPeer.requests.length, approvedWeb);
      assert.equal(
        (
          await request(`/api/v1/actions/${action.id}/decision`, "POST", {
            intentDigest: action.intentDigest,
            approved: true,
          })
        ).status,
        200,
      );
      approvedWeb++;
    }
    const researchedDone = await until(
      () => snapshot(researched.task.id),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(researchedDone.status, "completed", JSON.stringify(researchedDone));
    assert.equal(webPeer.requests.length, 3);
    assert.equal(researchedDone.artifacts.length, 1);
    assert.equal(
      researchedDone.actions.filter(
        (a) =>
          ["fetch", "read_public_page", "web_search"].includes(String(a.intent.tool)) &&
          a.status === "applied" &&
          a.decision === "approved",
      ).length,
      3,
    );
    console.log(
      "PASS required web approval -> pinned real HTTPS -> isolated HTML or Tavily search -> durable evidence -> independently reviewed publication",
    );
    assert.equal(
      (
        await request("/api/v1/settings/approvals", "PUT", {
          expectedRevision: webPolicy.revision + 1,
          productRead: "inherit",
          publicWeb: "inherit",
          exceptions: [],
        })
      ).status,
      200,
    );
    const beforeLimit = webPeer.requests.length;
    const overLimit = await create("Exhaust web calls https://example.com/evidence", webScope);
    await until(
      () => snapshot(overLimit.task.id),
      (t) => t.actions.some((a) => a.status === "unknown") || t.status === "failed",
    );
    assert.equal(webPeer.requests.length - beforeLimit, 4);
    assert.equal((await snapshot(overLimit.task.id)).artifacts.length, 0);
    console.log("PASS four-call web budget spans the whole task and blocks a fifth network send");

    const childBotId = randomUUID();
    await sql`INSERT INTO bots(id,name,role,computer_profile,configuration) VALUES(${childBotId},'Colleague fixture','Synthetic child','model',
      ${sql.json({ model: { connectionId: created.connection.id, modelId: "synthetic-model" } })}::jsonb)`;
    const collaborationScope = {
      version: 1,
      attachmentIds: [],
      collaboratorBotIds: [childBotId],
      knowledge: false,
      plugins: false,
      web: false,
    };
    for (const mode of ["delegate", "auto join"]) {
      hold = "Collaboration child " + mode;
      holdReview = false;
      reached = undefined;
      release = undefined;
      const root = await create("Collaboration root " + mode, collaborationScope);
      await until(
        async () => reached,
        (value) => value === hold,
      );
      const awaiting = await until(
        () => snapshot(root.task.id),
        (t) => t.actions.some((a) => a.intent.tool === "wait_for_task" && a.status === "proposed"),
      );
      assert.equal(awaiting.artifacts.length, 0);
      assert.equal(
        awaiting.actions
          .filter((a) => a.intent.tool === "wait_for_task")
          .every((a) => a.status === "proposed"),
        true,
      );
      const [relation] =
        await sql`SELECT * FROM work_collaborations WHERE parent_task_id=${root.task.id}`;
      assert.ok(relation);
      assert.equal(relation.source_kind, "task");
      assert.equal(relation.child_source_run_id, null);
      assert.equal(relation.assignment_message_id, null);
      const [childScope] =
        await sql`SELECT scope FROM work_task_scopes WHERE task_id=${relation.child_task_id}`;
      assert.ok(childScope);
      assert.deepEqual(childScope.scope.request.collaboratorBotIds, []);
      hold = undefined;
      release!();
      const done = await until(
        () => snapshot(root.task.id),
        (t) => ["completed", "failed"].includes(t.status),
      );
      assert.equal(done.status, "completed", JSON.stringify(done));
      assert.equal((await snapshot(relation.child_task_id)).status, "completed");
      assert.equal(
        done.actions.filter((a) => a.intent.tool === "wait_for_task" && a.status === "applied")
          .length,
        1,
      );
      assert.equal(
        Number(
          (
            await sql`SELECT count(*) AS n FROM work_collaborations WHERE parent_task_id=${root.task.id}`
          )[0]!.n,
        ),
        1,
      );
    }
    console.log(
      "PASS native delegate and automatic final join: narrowed real child identity, no admitted waiting effect, result redraft and independent publication",
    );

    const ungranted = await create("Collaboration root ungranted", collaborationScope);
    const ungrantedDone = await until(
      () => snapshot(ungranted.task.id),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(ungrantedDone.status, "failed");
    assert.equal(ungrantedDone.artifacts.length, 0);
    assert.equal(
      Number(
        (
          await sql`SELECT count(*) AS n FROM work_collaborations WHERE parent_task_id=${ungranted.task.id}`
        )[0]!.n,
      ),
      0,
    );
    assert.ok(
      ungrantedDone.events.some(
        (e) => e.kind === "task.failed" && e.payload.reason === "collaboration_target_not_granted",
      ),
      JSON.stringify(ungrantedDone),
    );
    console.log(
      "PASS model-selected colleague outside the Owner scope creates no child and cannot publish",
    );

    const originalRecord = WorkLedger.prototype.record;
    let creationReplyLosses = 0;
    WorkLedger.prototype.record = async function (binding, action, kind, value) {
      if (action.intent.tool === "start_task" && creationReplyLosses++ === 0)
        throw new Error("Synthetic lost creation response after SQL commit");
      return originalRecord.call(this, binding, action, kind, value);
    };
    try {
      const root = await create("Collaboration root receipt recovery", collaborationScope);
      const done = await until(
        () => snapshot(root.task.id),
        (t) => ["completed", "failed"].includes(t.status),
      );
      assert.equal(done.status, "completed", JSON.stringify(done));
      assert.equal(creationReplyLosses, 1);
      assert.equal(
        Number(
          (
            await sql`SELECT count(*) AS n FROM work_collaborations WHERE parent_task_id=${root.task.id}`
          )[0]!.n,
        ),
        1,
      );
    } finally {
      WorkLedger.prototype.record = originalRecord;
    }
    console.log(
      "PASS committed child creation survives lost acknowledgment through lookup-only recovery without a second child",
    );

    hold = "Collaboration child cancel";
    holdReview = false;
    reached = undefined;
    release = undefined;
    const cancelTree = await create("Collaboration root cancel", collaborationScope);
    await until(
      async () => reached,
      (value) => value === hold,
    );
    const [child] =
      await sql`SELECT child_task_id FROM work_collaborations WHERE parent_task_id=${cancelTree.task.id}`;
    assert.ok(child);
    const cancelledTree = await request(`/api/v1/tasks/${cancelTree.task.id}/cancel`, "POST", {});
    assert.equal(cancelledTree.status, 200, await cancelledTree.clone().text());
    const childBefore = await snapshot(child.child_task_id);
    assert.equal(childBefore.authorityActive, false);
    assert.equal(childBefore.cancelRequested, true);
    hold = undefined;
    release!();
    const childAfter = await until(
      () => snapshot(child.child_task_id),
      (t) => t.status === "cancelled",
    );
    assert.equal(childAfter.usage.spentTokens, 200);
    assert.equal(childAfter.artifacts.length, 0);
    assert.equal((await snapshot(cancelTree.task.id)).artifacts.length, 0);
    console.log(
      "PASS parent cancel closes descendant authority while retaining and settling actual late child model usage",
    );

    // Advance only the owned fixture's root claim clock, before creating any child. The product
    // still uses its actual 300-second SQL rule and real durable Temporal timer.
    let deadlineSeeded = false;
    WorkLedger.prototype.record = async function (binding, action, kind, value) {
      if (kind === "model" && action.intent.operation === "work" && !deadlineSeeded) {
        const [task] = await sql`SELECT objective FROM work_tasks WHERE id=${binding.input.taskId}`;
        if (task?.objective === "Collaboration root deadline") {
          await sql`UPDATE work_events SET created_at=clock_timestamp()-interval '292 seconds' WHERE task_id=${binding.input.taskId}
            AND kind='run.claimed' AND revision=(SELECT min(revision) FROM work_events WHERE task_id=${binding.input.taskId} AND kind='run.claimed')`;
          deadlineSeeded = true;
        }
      }
      return originalRecord.call(this, binding, action, kind, value);
    };
    let deadlineTask: string | undefined;
    try {
      hold = "Collaboration child deadline";
      holdReview = false;
      reached = undefined;
      release = undefined;
      const root = await create("Collaboration root deadline", collaborationScope);
      deadlineTask = root.task.id;
      await until(
        async () => reached,
        (value) => value === hold,
      );
      await until(
        () => snapshot(root.task.id),
        (t) => t.cancelRequested && !t.authorityActive,
      );
      const [child] =
        await sql`SELECT child_task_id FROM work_collaborations WHERE parent_task_id=${root.task.id}`;
      assert.ok(child);
      assert.equal((await snapshot(child.child_task_id)).authorityActive, false);
      assert.ok(
        (await snapshot(root.task.id)).events.some(
          (e) => e.payload.collaborationReason === "expired",
        ),
      );
      hold = undefined;
      release!();
      await until(
        () => snapshot(child.child_task_id),
        (t) =>
          t.actions.some((a) => a.status === "applied") ||
          t.actions.some((a) => a.status === "unknown"),
      );
      assert.equal((await snapshot(root.task.id)).artifacts.length, 0);
    } finally {
      WorkLedger.prototype.record = originalRecord;
      hold = undefined;
      (release as (() => void) | undefined)?.();
    }
    assert.equal(deadlineSeeded, true);
    console.log(
      "PASS actual Temporal collaboration deadline closes the tree during a held child call; fixture ages the first claim without changing the 300-second product limit",
    );

    hold = "Collaboration child correction";
    holdReview = false;
    reached = undefined;
    release = undefined;
    const corrected = await create("Collaboration root correction", collaborationScope);
    await until(
      async () => reached,
      (value) => value === hold,
    );
    await until(
      () => snapshot(corrected.task.id),
      (t) => t.actions.some((a) => a.intent.tool === "wait_for_task" && a.status === "proposed"),
    );
    const correction = await request(`/api/v1/tasks/${corrected.task.id}/corrections`, "POST", {
      runId: corrected.task.runs[0]!.id,
      instruction: "Retain the existing colleague and revise the final answer.",
      requestKey: randomUUID(),
      expectedSequence: 0,
    });
    assert.equal(correction.status, 202, await correction.clone().text());
    hold = undefined;
    release!();
    const correctedDone = await until(
      () => snapshot(corrected.task.id),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(correctedDone.status, "completed", JSON.stringify(correctedDone));
    assert.equal(
      Number(
        (
          await sql`SELECT count(*) AS n FROM work_collaborations WHERE parent_task_id=${corrected.task.id}`
        )[0]!.n,
      ),
      1,
    );
    assert.equal(
      correctedDone.actions.filter(
        (a) => a.intent.tool === "wait_for_task" && a.status === "applied",
      ).length,
      1,
    );
    assert.equal(
      correctedDone.actions.filter(
        (a) => a.intent.tool === "wait_for_task" && a.status === "superseded",
      ).length,
      1,
    );
    console.log(
      "PASS correction supersedes the pending join and reconsumes the same child in the current semantic context before publication",
    );

    const channelId = randomUUID(),
      channelBot = randomUUID(),
      channelChild = randomUUID();
    for (const [id, name] of [
      [channelBot, "Channel parent"],
      [channelChild, "Channel child"],
    ])
      await sql`INSERT INTO bots(id,name,role,computer_profile,configuration) VALUES(${id!},${name!},'Synthetic channel acceptance','model',${sql.json({ model: { connectionId: created.connection.id, modelId: "synthetic-model" } })}::jsonb)`;
    await sql`INSERT INTO channels(id,name,description) VALUES(${channelId},'P4 channel fixture','Disposable acceptance')`;
    for (const id of [channelBot, channelChild])
      await sql`INSERT INTO channel_bots(channel_id,bot_id) VALUES(${channelId},${id})`;
    const priorMessage = randomUUID();
    await sql`INSERT INTO messages(id,channel_id,author_type,content,created_at) VALUES(${priorMessage},${channelId},'human','Visible prior evidence',clock_timestamp()-interval '1 minute')`;
    const submitChannel = async (content: string, bot = channelBot) => {
      const response = await request(`/api/v1/channels/${channelId}/messages`, "POST", {
        content,
        botId: bot,
      });
      assert.equal(response.status, 201, await response.clone().text());
      const result = (await response.json()) as {
        message: { id: string };
        run: { id: string; workTaskId: string };
      };
      assert.ok(result.run.workTaskId);
      return result;
    };
    assert.equal(
      (
        await request(
          `/api/v1/channels/${channelId}/messages`,
          "POST",
          { content: "Denied" },
          false,
        )
      ).status,
      401,
    );
    const channelTask = await submitChannel("Channel read report");
    const futureMessage = randomUUID();
    await sql`INSERT INTO messages(id,channel_id,author_type,content,created_at) VALUES(${futureMessage},${channelId},'human','Do not expose this later request',clock_timestamp()+interval '1 minute')`;
    const channelDone = await until(
      () => snapshot(channelTask.run.workTaskId),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(channelDone.status, "completed", JSON.stringify(channelDone));
    const sourceRows =
      await sql`SELECT s.*,a.execution_owner FROM work_sources s JOIN work_runs r ON r.task_id=s.task_id JOIN work_admissions a ON a.run_id=r.id WHERE s.task_id=${channelDone.id}`;
    assert.equal(sourceRows.length, 1);
    assert.equal(sourceRows[0]!.legacy_run_id, channelTask.run.id);
    assert.equal(sourceRows[0]!.execution_owner, "typescript-v1");
    assert.equal(
      (await sql`SELECT 1 FROM work_task_profiles WHERE task_id=${channelDone.id}`).length,
      0,
    );
    const [published] =
      await sql`SELECT * FROM messages WHERE id=${"work-result:" + channelDone.id}`;
    assert.equal(published!.run_id, channelTask.run.id);
    assert.equal(published!.reply_to_message_id, channelTask.message.id);
    const channelRead = channelDone.actions.find((a) => a.intent.tool === "read_channel_context")!;
    const [readBlob] =
      await sql`SELECT t.sha256 FROM work_tool_results t WHERE t.action_id=${channelRead.id}`;
    assert.ok(readBlob); // Read the actual immutable observation below using the established private blob layout.
    const storedRead = JSON.parse(await readFile(join(files, readBlob.sha256), "utf8"));
    assert.ok(storedRead.result.some((m: { id: string }) => m.id === priorMessage));
    assert.ok(!storedRead.result.some((m: { id: string }) => m.id === futureMessage));
    const crossChannel = randomUUID(),
      foreignMessage = randomUUID();
    await sql`INSERT INTO channels(id,name) VALUES(${crossChannel},'Other private fixture')`;
    await sql`INSERT INTO messages(id,channel_id,author_type,content) VALUES(${foreignMessage},${crossChannel},'human','Outside task channel')`;
    assert.equal(
      (
        await request(`/api/v1/channels/${channelId}/messages`, "POST", {
          content: "Foreign reply",
          botId: channelBot,
          replyToMessageId: foreignMessage,
        })
      ).status,
      422,
    );
    const denied = await request(`/api/v1/channels/${channelId}/messages`, "POST", {
      content: "All or nothing recipients",
      botIds: [channelBot, randomUUID()],
    });
    assert.equal(denied.status, 422);
    assert.equal(
      (
        await sql`SELECT 1 FROM messages WHERE channel_id=${channelId} AND content='All or nothing recipients'`
      ).length,
      0,
    );
    console.log(
      "PASS real channel message/Run/TS Work admission, fixed context boundary, atomic result publication and all-recipient authorization",
    );

    hold = "Channel steering";
    holdReview = false;
    reached = undefined;
    release = undefined;
    const steeringTask = await submitChannel(hold);
    await until(
      async () => reached,
      (v) => v === hold,
    );
    const steering = await request(`/api/v1/runs/${steeringTask.run.id}/steer`, "POST", {
      instruction: "Use only the corrected synthetic evidence",
    });
    assert.equal(steering.status, 202, await steering.clone().text());
    hold = undefined;
    release!();
    const steered = await until(
      () => snapshot(steeringTask.run.workTaskId),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(steered.status, "completed", JSON.stringify(steered));
    assert.equal((await sql`SELECT 1 FROM work_corrections WHERE task_id=${steered.id}`).length, 1);
    hold = "Channel cancellation";
    reached = undefined;
    release = undefined;
    const cancelChannel = await submitChannel(hold);
    await until(
      async () => reached,
      (v) => v === hold,
    );
    const cancellation = await request(`/api/v1/runs/${cancelChannel.run.id}/cancel`, "POST", {});
    assert.equal(cancellation.status, 200, await cancellation.clone().text());
    hold = undefined;
    release!();
    const cancelledChannel = await until(
      () => snapshot(cancelChannel.run.workTaskId),
      (t) => t.status === "cancelled",
    );
    assert.equal(cancelledChannel.artifacts.length, 0);
    assert.ok(cancelledChannel.usage.spentTokens > 0);
    console.log(
      "PASS channel Run steering bridges the same correction context; cancellation retains late actual usage without publication",
    );

    hold = "Collaboration child channel delegate";
    reached = undefined;
    release = undefined;
    const channelTree = await submitChannel("Collaboration root channel delegate");
    await until(
      async () => reached,
      (v) => v === hold,
    );
    const [channelRelation] =
      await sql`SELECT * FROM work_collaborations WHERE parent_task_id=${channelTree.run.workTaskId}`;
    assert.equal(channelRelation!.source_kind, "channel");
    assert.ok(channelRelation!.child_source_run_id);
    assert.ok(channelRelation!.assignment_message_id);
    hold = undefined;
    release!();
    const treeDone = await until(
      () => snapshot(channelTree.run.workTaskId),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(treeDone.status, "completed", JSON.stringify(treeDone));
    assert.equal((await snapshot(channelRelation!.child_task_id)).status, "completed");
    assert.equal(
      treeDone.actions.filter((a) => a.intent.tool === "wait_for_task" && a.status === "applied")
        .length,
      1,
    );
    assert.equal(
      (await sql`SELECT 1 FROM work_task_scopes WHERE task_id=${channelRelation!.child_task_id}`)
        .length,
      0,
    );
    console.log(
      "PASS channel delegate uses real assignment/source Run identities, durable join and atomic child/root messages",
    );

    const tooMany = await request(`/api/v1/channels/${channelId}/messages`, "POST", {
      content: Array.from({ length: 9 }, () => `[OpenBot attachment: ${randomUUID()}]`).join(" "),
      botId: channelBot,
    });
    assert.equal(tooMany.status, 413);
    const parallelTrees = await Promise.all(
      [0, 1].map((i) => submitChannel(`Collaboration root channel parallel ${i}`)),
    );
    for (const tree of parallelTrees) {
      const done = await until(
        () => snapshot(tree.run.workTaskId),
        (t) => ["completed", "failed"].includes(t.status),
        90000,
      );
      assert.equal(done.status, "completed", JSON.stringify(done));
    }
    console.log(
      "PASS concurrent channel collaboration trees preserve separate source/ancestor locks and completion",
    );

    const resourceUpload = await fetch(origin + `/api/v1/channels/${channelId}/attachments`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: "openbot_session=" + token,
        "Content-Type": "application/octet-stream",
        "X-OpenBot-Filename": "channel-evidence.txt",
      },
      body: "Channel scoped synthetic evidence",
    });
    assert.equal(resourceUpload.status, 201, await resourceUpload.clone().text());
    const channelAttachment = ((await resourceUpload.json()) as { attachment: { id: string } })
      .attachment;
    const channelGrant = await request(
      `/api/v1/plugins/${installed.id}/grants/${channelBot}`,
      "PUT",
      {
        revision: installed.revision,
        tools: [{ name: "echo", mode: "read" }],
        resources: ["fixture://evidence"],
        prompts: [],
      },
    );
    assert.equal(channelGrant.status, 200, await channelGrant.clone().text());
    installed = ((await channelGrant.json()) as { plugin: typeof installed }).plugin;
    const combined = await submitChannel(
      `Channel resources https://example.com/evidence [OpenBot attachment: ${channelAttachment.id}]`,
    );
    const combinedDone = await until(
      () => snapshot(combined.run.workTaskId),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(combinedDone.status, "completed", JSON.stringify(combinedDone));
    for (const tool of [
      "read_attachment",
      "knowledge_catalog",
      "propose_memory",
      "call_plugin",
      "read_plugin_resource",
      "read_public_page",
      "web_search",
    ])
      assert.ok(
        combinedDone.actions.some((a) => a.intent.tool === tool && a.status === "applied"),
        tool,
      );
    const [channelProposal] =
      await sql`SELECT * FROM knowledge_proposals WHERE source_run_id=${combined.run.id}`;
    assert.equal(channelProposal!.source_kind, "channel");
    assert.equal(channelProposal!.source_work_run_id, null);
    assert.equal(channelProposal!.status, "pending");
    assert.equal(
      (
        await sql`SELECT 1 FROM run_events WHERE run_id=${combined.run.id} AND type='KNOWLEDGE_PROPOSED'`
      ).length,
      1,
    );
    console.log(
      "PASS channel-scoped attachments, knowledge proposal provenance, MCP and HTTPS evidence share the same live source authority",
    );

    hold = "Channel member revocation";
    holdReview = true;
    reached = undefined;
    release = undefined;
    const revokedMember = await submitChannel(hold);
    await until(
      async () => reached,
      (v) => v === hold,
    );
    const removal = await request(`/api/v1/channels/${channelId}/bots/${channelBot}`, "DELETE");
    assert.equal(removal.status, 200, await removal.clone().text());
    hold = undefined;
    holdReview = false;
    release!();
    const revokedChannel = await until(
      () => snapshot(revokedMember.run.workTaskId),
      (t) => t.status === "cancelled",
    );
    assert.equal(revokedChannel.artifacts.length, 0);
    assert.equal(
      (await sql`SELECT 1 FROM messages WHERE id=${"work-result:" + revokedChannel.id}`).length,
      0,
    );
    console.log(
      "PASS existing public member removal closes TS channel authority during review and prevents publication",
    );

    hold = "Channel automation";
    reached = undefined;
    release = undefined;
    const scheduled = await request("/api/v1/automations", "POST", {
      name: "P4 schedule",
      channelId,
      botId: channelChild,
      prompt: hold,
      intervalMinutes: 60,
      firstRunAt: new Date(Date.now() + 60000).toISOString(),
    });
    assert.equal(scheduled.status, 201, await scheduled.clone().text());
    const schedule = ((await scheduled.json()) as { automation: { id: string } }).automation;
    await sql`UPDATE automations SET next_run_at=date_trunc('milliseconds',clock_timestamp())-interval '5 hours'+interval '333 microseconds' WHERE id=${schedule.id}`;
    await until(
      async () => reached,
      (v) => v === hold,
    );
    const [occurrence] =
      await sql`SELECT a.*,r.work_task_id FROM automations a JOIN runs_work_projection r ON r.id=a.last_run_id WHERE a.id=${schedule.id}`;
    assert.equal(occurrence!.last_outcome, "submitted");
    const [scheduleMessage] =
      await sql`SELECT m.author_type FROM messages m JOIN runs r ON r.source_message_id=m.id WHERE r.id=${occurrence!.last_run_id}`;
    assert.equal(scheduleMessage!.author_type, "system");
    await sql`UPDATE automations SET next_run_at=date_trunc('milliseconds',clock_timestamp())-interval '5 hours'+interval '333 microseconds',last_outcome=NULL WHERE id=${schedule.id}`;
    const skipped = await until(
      async () =>
        [
          ...(await sql`SELECT *,next_run_at>clock_timestamp() AS future,extract(microseconds FROM next_run_at)::bigint%1000 AS remainder FROM automations WHERE id=${schedule.id}`),
        ][0]!,
      (a) => a.last_outcome === "skipped_active",
    );
    assert.equal(skipped.last_run_id, occurrence!.last_run_id);
    assert.equal(skipped.future, true);
    assert.equal(Number(skipped.remainder), 333);
    hold = undefined;
    release!();
    assert.equal(
      (
        await until(
          () => snapshot(occurrence!.work_task_id),
          (t) => ["completed", "failed"].includes(t.status),
        )
      ).status,
      "completed",
    );
    assert.equal(
      (
        await sql`SELECT 1 FROM run_events WHERE type='RUN_CREATED' AND payload->>'automationId'=${schedule.id}`
      ).length,
      1,
    );
    await sql`DELETE FROM channel_bots WHERE channel_id=${channelId} AND bot_id=${channelChild}`;
    await sql`UPDATE automations SET next_run_at=clock_timestamp()-interval '1 second',last_outcome=NULL WHERE id=${schedule.id}`;
    const unavailable = await until(
      async () => [...(await sql`SELECT * FROM automations WHERE id=${schedule.id}`)][0]!,
      (a) => a.last_outcome === "target_unavailable",
    );
    assert.equal(unavailable.enabled, false);
    assert.equal(
      (
        await sql`SELECT 1 FROM run_events WHERE type='RUN_CREATED' AND payload->>'automationId'=${schedule.id}`
      ).length,
      1,
    );
    console.log(
      "PASS sole TS automation admission creates system source Work, skips an active predecessor, advances missed intervals exactly and disables unavailable targets without partial writes",
    );

    const lost = await create("Lost response");
    await until(
      () => snapshot(lost.task.id),
      (t) => t.actions.some((a) => a.status === "unknown"),
    );
    await app!.close();
    app = undefined;
    await start();
    const unknown = await snapshot(lost.task.id);
    assert.equal(unknown.attention, "reconciliation");
    assert.equal(unknown.artifacts.length, 0);
    assert.equal(calls.get("Lost response"), 1);
    const action = unknown.actions[0]!;
    const command = await request(`/api/v1/actions/${action.id}/reconcile`, "POST", {
      intentDigest: action.intentDigest,
      requestKey: randomUUID(),
      expectedSequence: 0,
      reason: "Lookup original receipt",
    });
    assert.equal(command.status, 202, await command.clone().text());
    const lookup = await until(
      () => snapshot(lost.task.id),
      (t) => t.actions[0]?.reconciliation?.outcome === "unresolved",
    );
    assert.equal(lookup.actions[0]!.status, "unknown");
    assert.equal(calls.get("Lost response"), 1);
    console.log(
      "PASS entry/Worker restart and Owner reconciliation remain lookup-only after lost provider response",
    );

    if (deadlineTask) {
      const [row] = await sql`SELECT id FROM work_runs WHERE task_id=${deadlineTask}`;
      assert.ok(row);
      const handle = engineClient.workflow.getHandle(WORKFLOW_ID_PREFIX + row.id);
      await handle.result();
      const history = await handle.fetchHistory();
      assert.ok(
        history.events?.some(
          (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === "closeWorkTree",
        ),
      );
      assert.ok(history.events?.some((e) => e.timerFiredEventAttributes));
    }

    const [accepted] =
      await sql`SELECT a.*,r.id AS run_id FROM work_admissions a JOIN work_runs r ON r.id=a.run_id WHERE r.task_id=${lost.task.id}`;
    await engineClient.workflow
      .getHandle(WORKFLOW_ID_PREFIX + accepted!.run_id)
      .terminate("Owned product terminal recovery probe");
    const terminal = await until(
      () => snapshot(lost.task.id),
      (t) => t.status === "failed",
    );
    assert.equal(terminal.actions[0]!.status, "unknown");
    assert.equal(terminal.usage.reservedTokens, lookup.usage.reservedTokens);
    assert.equal(terminal.artifacts.length, 0);
    const proof = await observeEngineClosure(
      engineClient,
      options.product!.work!,
      { taskId: lost.task.id, runId: accepted!.run_id, attemptId: accepted!.submission_attempt_id },
      accepted!.engine_first_run_id,
    );
    assert(proof);
    assert.equal(proof.state, "TERMINATED");
    assertEngineClosure(proof);
    assert.throws(() => assertEngineClosure({ ...proof }), /proof_required/);
    await assert.rejects(
      observeEngineClosure(
        engineClient,
        options.product!.work!,
        { ...proof.input, attemptId: "f".repeat(32) },
        proof.firstRunId,
      ),
      /terminal_start_changed/,
    );
    const closedCommand = await request(`/api/v1/actions/${action.id}/reconcile`, "POST", {
      intentDigest: action.intentDigest,
      requestKey: randomUUID(),
      expectedSequence: 1,
      reason: "Lookup after engine closure",
    });
    assert.equal(closedCommand.status, 202, await closedCommand.clone().text());
    const closedLookup = await until(
      () => snapshot(lost.task.id),
      (t) =>
        t.actions[0]?.reconciliation?.sequence === 2 &&
        t.actions[0]?.reconciliation?.outcome === "unresolved",
    );
    assert.equal(closedLookup.actions[0]!.status, "unknown");
    const [repairCommand] =
      await sql`SELECT delivery_reference FROM work_reconciliation_commands WHERE action_id=${action.id} AND sequence=2`;
    assert(String(repairCommand!.delivery_reference).startsWith("openbot-closed-repair-ts-v1-"));
    const repairHandle = engineClient.workflow.getHandle(repairCommand!.delivery_reference);
    await repairHandle.result();
    const repairHistory = await repairHandle.fetchHistory();
    assert(repairHistory.events?.some((event) => event.activityTaskCompletedEventAttributes));
    assert(!repairHistory.events?.some((event) => event.activityTaskFailedEventAttributes));
    assert.equal(calls.get("Lost response"), 1);
    console.log(
      "PASS actual engine termination projects failure; closed reconciliation keeps reservations and never dispatches again; copied/wrong-input proofs rejected",
    );
  } finally {
    release?.();
    try {
      await app?.close();
    } finally {
      await commandPeer?.close();
      await pluginPeer.close();
      await webPeer?.close();
      await engineConnection?.close();
      await sql.end({ timeout: 1 });
      await rm(directory, { recursive: true, force: true });
    }
  }
}
