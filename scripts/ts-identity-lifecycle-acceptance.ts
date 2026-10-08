import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "@openbot/db";
import { BotGreetings } from "../apps/server-ts/dist/bot-greeting.js";
import { plainGreeting, GreetingFailure } from "../apps/server-ts/dist/greeting-text.js";
import { ModelConnections } from "../apps/server-ts/dist/model-connections.js";
import { ownerTransactions } from "../apps/server-ts/dist/owner-transaction.js";
import type { ModelTransport } from "../apps/server-ts/dist/model-network.js";
import type { AuthorizedProductOperation } from "../apps/server-ts/dist/product-identity.js";
export async function qualifyIdentityLifecycle(options: {
  databaseUrl: string;
  origin: string;
  privateOrigin: string;
  cookie: string;
  modelKeyPath: string;
  root: string;
  stopPython(): Promise<void>;
  restorePython(): Promise<void>;
  reverseToPython(): Promise<void>;
  restoreTs(): Promise<void>;
}) {
  const database = createDatabase(options.databaseUrl),
    sql = database.client,
    store = ownerTransactions(options.databaseUrl);
  const token = options.cookie.split("=")[1]!,
    signal = new AbortController().signal;
  const owner: AuthorizedProductOperation = (work, abort) =>
    store.run(token, abort ?? signal, work);
  const models = new ModelConnections(options.modelKeyPath),
    bots: string[] = [],
    channels: string[] = [],
    greetings: BotGreetings[] = [];
  let connection = "",
    passed = 0,
    prior: any;
  const appearance = {
    head: "cat",
    body: "classic",
    mobility: "feet",
    accessory: "none",
    accent: "blue",
  };
  const check = async (name: string, work: () => Promise<void>) => {
    await work();
    passed++;
    console.log("identity-lifecycle: " + name);
  };
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    origin = options.origin,
    cookie = options.cookie,
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: options.origin,
        Host: new URL(options.origin).host,
        ...(origin === options.privateOrigin ? { Forwarded: "for=127.0.0.1" } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12000),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const ordinary = async () => {
    const r = await request("/api/v1/bots", "POST", {
      name: "Identity " + randomUUID(),
      role: "Synthetic",
      computerProfile: "none",
      appearance,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.bot.appearance, appearance);
    bots.push(r.body.bot.id);
    return r.body.bot;
  };
  const conversation = async (bot: string) => {
    const r = await request(`/api/v1/bots/${bot}/conversation`, "POST", {});
    assert.equal(r.status, 200);
    channels.push(r.body.channel.id);
    return r.body.channel.id;
  };
  const rows = async (bot: string) =>
    Array.from(await sql`SELECT content,origin FROM messages WHERE author_id=${bot}`);
  const reasons = async (bot: string) =>
    (
      await sql`SELECT payload->>'reason' AS reason FROM run_events WHERE bot_id=${bot} AND type='BOT_GREETING_FAILED'`
    ).map((r) => r.reason);
  const response = () => ({
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    bytes: Buffer.from(
      JSON.stringify({
        id: "synthetic",
        object: "chat.completion",
        model: "fixture/model",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "**你好**。你希望我负责哪些任务？" },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      }),
    ),
  });
  const greet = async (transport: ModelTransport) => {
    const bot = await ordinary(),
      channel = await conversation(bot.id);
    await sql`UPDATE bots SET configuration=jsonb_set(configuration,'{model}',${JSON.stringify({ connectionId: connection, modelId: "fixture/model" })}::jsonb) WHERE id=${bot.id}`;
    const service = new BotGreetings(options.databaseUrl, models, transport);
    greetings.push(service);
    return { bot: bot.id, channel, service };
  };
  try {
    await check(
      "five private routes are quarantined and authentication precedes parsing",
      async () => {
        for (const [method, path] of [
          ["POST", "/api/v1/bots"],
          ["POST", "/api/v1/bots/quick"],
          ["DELETE", "/api/v1/bots/fixture"],
          ["DELETE", "/api/v1/channels/fixture"],
          ["DELETE", "/api/v1/channels/fixture/bots/fixture"],
        ]) {
          const r = await request(path!, method, {}, options.privateOrigin);
          assert.equal(r.status, 503);
          assert.equal(r.body.error, "operation_owned_by_ts");
        }
        assert.equal((await request("/api/v1/bots", "POST", {}, options.origin, "")).status, 401);
        assert.equal(
          (await request("/api/v1/bots/quick", "POST", { appearance, extra: true })).status,
          422,
        );
      },
    );
    await check(
      "workspace snapshot remains consistent during a concurrent primary preference commit, paired reverse and TS",
      async () => {
        for (const origin of [options.privateOrigin, options.origin]) {
          if (origin === options.privateOrigin) await options.reverseToPython();
          else await options.restoreTs();
          const writer = await sql.reserve();
          let response: Awaited<ReturnType<typeof request>> | undefined,
            finished = false,
            blocked = false;
          try {
            await writer`BEGIN`;
            const [before] =
              await writer`SELECT revision FROM workspace_settings WHERE workspace_id='workspace' FOR UPDATE`;
            await writer`UPDATE workspace_settings SET revision=revision+1 WHERE workspace_id='workspace'`;
            const pending = request("/api/v1/workspace", "GET", undefined, options.origin).then(
              (value) => {
                finished = true;
                response = value;
              },
            );
            for (let n = 0; n < 60 && !finished; n++) {
              const wait =
                await sql`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND application_name='openbot-control-identity' AND query LIKE '%SELECT primary_bot_id,revision FROM workspace_settings%'`;
              if (wait.length) {
                blocked = true;
                break;
              }
              await delay(10);
            }
            await writer`COMMIT`;
            await pending;
            console.log(
              "workspace-race: " +
                (origin === options.privateOrigin ? "private Python" : "TS entry") +
                ", blocked=" +
                blocked +
                ", status=" +
                response!.status,
            );
            assert.equal(response!.status, 200, JSON.stringify(response!.body));
            assert.equal(response!.body.revision, before!.revision);
          } finally {
            if (!finished) await writer`ROLLBACK`;
            writer.release();
          }
        }
      },
    );
    await options.stopPython();
    prior = (await sql`SELECT default_model FROM owner_preferences WHERE owner_id='owner'`)[0]!
      .default_model;
    await sql`UPDATE owner_preferences SET default_model=NULL WHERE owner_id='owner'`;
    await check(
      "concurrent quick creation commits distinct Chinese names, conversations and one optional attempt",
      async () => {
        const results = await Promise.all(
          Array.from({ length: 3 }, () => request("/api/v1/bots/quick", "POST", { appearance })),
        );
        for (const result of results) {
          assert.equal(result.status, 201, JSON.stringify(result.body));
          bots.push(result.body.bot.id);
          channels.push(result.body.channel.id);
          assert.match(result.body.bot.name, /^新建 Bot(?: [0-9]+)?$/);
          assert.equal(result.body.bot.computerProfile, "none");
          assert.deepEqual(result.body.channel.botIds, [result.body.bot.id]);
        }
        assert.equal(new Set(results.map((r) => r.body.bot.name)).size, 3);
        for (let n = 0; n < 40; n++) {
          if ((await reasons(results[0]!.body.bot.id)).length) break;
          await delay(25);
        }
        assert.deepEqual(await reasons(results[0]!.body.bot.id), ["model_unavailable"]);
        assert.equal(
          (
            await request("/api/v1/bots", "POST", {
              name: results[0]!.body.bot.name,
              role: "Synthetic",
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await sql`SELECT 1 FROM employee_evolution_events WHERE bot_id=ANY(${results.map((r) => r.body.bot.id)}) AND type='created'`
          ).length,
          3,
        );
      },
    );
    await check(
      "identity/evolution/audit roll back together on a failed audit commit",
      async () => {
        const name = "Rejected " + randomUUID();
        await sql.unsafe(
          "CREATE FUNCTION reject_identity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='BOT_CREATED' THEN RAISE EXCEPTION 'synthetic refusal'; END IF; RETURN NEW; END $$",
        );
        await sql.unsafe(
          "CREATE TRIGGER reject_identity_fixture BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_identity_fixture()",
        );
        try {
          assert.equal(
            (await request("/api/v1/bots", "POST", { name, role: "Synthetic" })).status,
            503,
          );
          assert.equal((await sql`SELECT id FROM bots WHERE name=${name}`).length, 0);
        } finally {
          await sql.unsafe("DROP TRIGGER reject_identity_fixture ON run_events");
          await sql.unsafe("DROP FUNCTION reject_identity_fixture()");
        }
      },
    );
    const mc = await request("/api/v1/model-connections", "POST", {
      name: "Greeting synthetic " + randomUUID(),
      presetId: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "synthetic-greeting-fixture",
    });
    assert.equal(mc.status, 201, JSON.stringify(mc.body));
    connection = mc.body.connection.id;
    await owner((db) => models.initialize(db));
    await check(
      "actual SDK and Owner SQL publish one bounded greeting with Python stopped",
      async () => {
        let calls = 0;
        const value = await greet(async (r) => {
          calls++;
          const body = JSON.parse(r.body!);
          assert.equal(r.maximum, 32768);
          assert.equal(body.max_completion_tokens, 256);
          assert.equal(body.messages.length, 2);
          assert(!body.tools);
          const payload = JSON.parse(body.messages[1].content);
          assert.deepEqual(Object.keys(payload).sort(), ["name", "others"]);
          assert(payload.others.length <= 12);
          return response();
        });
        await value.service.run(owner, value.bot, value.channel);
        await value.service.run(owner, value.bot, value.channel);
        assert.equal(calls, 1, JSON.stringify(await reasons(value.bot)));
        assert.deepEqual(await rows(value.bot), [
          { content: "你好。你希望我负责哪些任务？", origin: "greeting" },
        ]);
        const events =
          await sql`SELECT payload FROM run_events WHERE bot_id=${value.bot} AND type='MESSAGE_CREATED'`;
        assert.equal(events.length, 1);
        assert.deepEqual(Object.keys(events[0]!.payload).sort(), [
          "authorType",
          "messageId",
          "origin",
        ]);
      },
    );
    await check(
      "Owner first send, changed model and revoked session prevent late greeting publication",
      async () => {
        for (const mode of ["human", "model", "owner"]) {
          let calls = 0;
          const session = randomUUID(),
            sessionToken = randomBytes(32).toString("base64url");
          await sql`INSERT INTO auth_sessions(id,token_digest,owner_id,expires_at) VALUES(${session},${createHash("sha256").update(sessionToken).digest("hex")},'owner',now()+interval '1 hour')`;
          const value = await greet(async () => {
            calls++;
            if (mode === "human")
              await sql`INSERT INTO messages(id,channel_id,author_type,content) VALUES(${randomUUID()},${value.channel},'human','Synthetic first message')`;
            if (mode === "model")
              await sql`UPDATE bots SET configuration=configuration-'model' WHERE id=${value.bot}`;
            if (mode === "owner")
              await sql`UPDATE auth_sessions SET revoked_at=now() WHERE id=${session}`;
            return response();
          });
          const authority: AuthorizedProductOperation = (op, signal) =>
            store.run(sessionToken, signal ?? new AbortController().signal, op);
          await value.service.run(authority, value.bot, value.channel);
          assert.equal(calls, 1);
          assert.deepEqual(await rows(value.bot), []);
          assert.deepEqual(await reasons(value.bot), [
            mode === "human"
              ? "conversation_started"
              : mode === "model"
                ? "model_changed"
                : "authority_changed",
          ]);
        }
      },
    );
    await check(
      "failed message audit rolls back text, records one fixed failure and never retries",
      async () => {
        let calls = 0;
        const value = await greet(async () => {
          calls++;
          return response();
        });
        await sql.unsafe(
          "CREATE FUNCTION reject_greeting_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='MESSAGE_CREATED' AND NEW.payload->>'origin'='greeting' THEN RAISE EXCEPTION 'synthetic refusal'; END IF; RETURN NEW; END $$",
        );
        await sql.unsafe(
          "CREATE TRIGGER reject_greeting_fixture BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_greeting_fixture()",
        );
        try {
          await value.service.run(owner, value.bot, value.channel);
          await value.service.run(owner, value.bot, value.channel);
          assert.equal(calls, 1);
          assert.deepEqual(await rows(value.bot), []);
          assert.deepEqual(await reasons(value.bot), ["operation_failed"]);
        } finally {
          await sql.unsafe("DROP TRIGGER reject_greeting_fixture ON run_events");
          await sql.unsafe("DROP FUNCTION reject_greeting_fixture()");
        }
      },
    );
    await check(
      "real model deadline and shutdown cancel the request, await settlement and audit without text",
      async () => {
        for (const mode of ["timeout", "cancelled"]) {
          let calls = 0,
            settled = false;
          let entered!: () => void;
          const start = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const value = await greet(async (request) => {
            calls++;
            entered();
            try {
              return await new Promise<ReturnType<typeof response>>((_resolve, reject) => {
                request.signal.addEventListener("abort", () => reject(request.signal.reason), {
                  once: true,
                });
              });
            } finally {
              settled = true;
            }
          });
          value.service.schedule(owner, value.bot, value.channel);
          await Promise.race([
            start,
            delay(5000).then(() => {
              throw new Error("Greeting did not reach the synthetic provider.");
            }),
          ]);
          if (mode === "cancelled") await value.service.close();
          else {
            for (let n = 0; n < 90; n++) {
              if ((await reasons(value.bot)).length) break;
              await delay(200);
            }
          }
          assert.equal(calls, 1);
          assert.equal(settled, true);
          assert.deepEqual(await rows(value.bot), []);
          assert.deepEqual(await reasons(value.bot), [mode]);
        }
      },
    );
    await check(
      "retained Python and TS plain-text normalization agree on numeric entities and Unicode controls",
      async () => {
        const values = [
          ...Array.from({ length: 256 }, (_, n) => "你好&#" + n + ";团队。你想让我做什么？"),
          ...[
            "\u001c",
            "\u0085",
            "\uFEFF",
            "\u2028",
            "\u2029",
            "\u3000",
            "&NotEqualTilde;",
            "&notin;",
            "&#xFFFF;",
            "&#x10ffff;",
            "&#x110000;",
            "&#xD800;",
            "<think>hidden</think>",
            "[OpenBot private]",
            "### ",
            "&amp",
          ].map((v) => v + "你好。你想让我做什么？"),
        ];
        const code =
          "import sys,json;sys.path.insert(0,sys.argv[1]);from openbot_server.bot_greeting import plain_greeting,GreetingFailure\ndef run(v):\n try:return plain_greeting(v)\n except GreetingFailure as e:return {'error':e.reason}\nprint(json.dumps([run(v) for v in json.load(sys.stdin)],ensure_ascii=True))";
        const expected = JSON.parse(
          execFileSync(
            join(options.root, "apps/server-python/.worker-venv/bin/python"),
            ["-I", "-B", "-c", code, join(options.root, "apps/server-python/src")],
            {
              input: JSON.stringify(values),
              encoding: "utf8",
              timeout: 15000,
              env: { PATH: process.env.PATH ?? "" },
            },
          ),
        );
        const actual = values.map((v) => {
          try {
            return plainGreeting(v);
          } catch (error) {
            return { error: error instanceof GreetingFailure ? error.reason : "unexpected" };
          }
        });
        assert.deepEqual(actual, expected);
      },
    );
    await check(
      "member removal cancels queued Work but retains unknown effects and reservations",
      async () => {
        const bot = await ordinary(),
          channel = randomUUID();
        channels.push(channel);
        await sql`INSERT INTO channels(id,name,description) VALUES(${channel},${"Members " + randomUUID()},'Synthetic')`;
        await sql`INSERT INTO channel_bots(channel_id,bot_id) VALUES(${channel},${bot.id})`;
        const cases = [];
        for (const unknown of [false, true]) {
          const run = randomUUID(),
            task = randomUUID(),
            work = randomUUID(),
            message = randomUUID();
          await sql`INSERT INTO messages(id,channel_id,author_type,content) VALUES(${message},${channel},'human','Synthetic')`;
          await sql`INSERT INTO runs(id,channel_id,bot_id,execution_profile,instruction,title,status,source_message_id) VALUES(${run},${channel},${bot.id},'none','Synthetic','Synthetic','queued',${message})`;
          await sql`INSERT INTO work_tasks(id,owner_id,bot_id,request_key,request_digest,objective,token_limit,status) VALUES(${task},'owner',${bot.id},${randomUUID()},${"a".repeat(64)},'Synthetic',100,'open')`;
          await sql`INSERT INTO work_runs(id,task_id,ordinal,status) VALUES(${work},${task},1,'running')`;
          await sql`INSERT INTO work_sources(task_id,legacy_run_id,channel_id,source_message_id) VALUES(${task},${run},${channel},${message})`;
          if (unknown)
            await sql`INSERT INTO work_actions(id,task_id,run_id,action_key,intent,intent_digest,authority_generation,requires_approval,decision,expires_at,reserved_tokens,status,baseline_requires_approval) VALUES(${randomUUID()},${task},${work},'fixture','{}'::jsonb,${"b".repeat(64)},1,false,'not_required',now()+interval '1 hour',17,'unknown',false)`;
          cases.push({ task, run, unknown });
        }
        assert.equal((await request("/api/v1/channels/" + channel, "DELETE")).status, 409);
        const result = await request(`/api/v1/channels/${channel}/bots/${bot.id}`, "DELETE");
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.deepEqual(result.body.channel.botIds, []);
        for (const value of cases) {
          const row = (
            await sql`SELECT status,authority_active,cancel_requested,authority_generation FROM work_tasks WHERE id=${value.task}`
          )[0]!;
          assert.equal(row.status, value.unknown ? "open" : "cancelled");
          assert.equal(row.authority_active, false);
          assert.equal(row.cancel_requested, true);
          assert.equal(Number(row.authority_generation), 2);
          assert.equal(
            result.body.cancelledRuns.find((r: any) => r.id === value.run).status,
            value.unknown ? "blocked" : "cancelled",
          );
        }
        assert.equal(
          Number(
            (
              await sql`SELECT reserved_tokens FROM work_actions WHERE task_id=${cases[1]!.task}`
            )[0]!.reserved_tokens,
          ),
          17,
        );
        assert.equal((await request("/api/v1/channels/" + channel, "DELETE")).status, 409);
        await sql`UPDATE work_actions SET status='not_applied',actual_tokens=0,evidence='{}'::jsonb WHERE task_id=${cases[1]!.task}`;
        await sql`UPDATE work_tasks SET status='cancelled' WHERE id=${cases[1]!.task}`;
        const deleted = await request("/api/v1/channels/" + channel, "DELETE");
        assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
        assert.equal(deleted.body.attachmentsRemoved, true);
        assert(
          (await sql`SELECT content FROM messages WHERE channel_id=${channel}`).every(
            (r) => r.content === "（内容已删除）",
          ),
        );
      },
    );
    await check(
      "native collaboration NULL message references never preserve unrelated deleted conversation text",
      async () => {
        const first = await ordinary(),
          second = await ordinary();
        const hash = (value: unknown) => {
          const sort = (v: any): any =>
            Array.isArray(v)
              ? v.map(sort)
              : v && typeof v === "object"
                ? Object.fromEntries(
                    Object.keys(v)
                      .sort()
                      .map((k) => [k, sort(v[k])]),
                  )
                : v;
          return createHash("sha256")
            .update(JSON.stringify(sort(value)))
            .digest("hex");
        };
        const native = async (bot: string, peers: string[]) => {
          const task = randomUUID(),
            run = randomUUID();
          await sql`INSERT INTO work_tasks(id,owner_id,bot_id,request_key,request_digest,objective,token_limit,status,authority_active,completion_digest) VALUES(${task},'owner',${bot},${randomUUID()},${"a".repeat(64)},'Synthetic completed source',0,'completed',false,${"b".repeat(64)})`;
          await sql`INSERT INTO work_runs(id,task_id,ordinal,status) VALUES(${run},${task},1,'completed')`;
          const profile = {
            kind: "work_task_profile",
            version: 1,
            taskId: task,
            botId: bot,
            executionProfile: "none",
            modelSelection: null,
          };
          await sql`INSERT INTO work_task_profiles(task_id,bot_id,execution_profile,model_selection,profile_digest) VALUES(${task},${bot},'none',NULL,${hash(profile)})`;
          const scope = {
            version: 1,
            taskId: task,
            botId: bot,
            request: {
              version: 1,
              attachmentIds: [],
              collaboratorBotIds: peers,
              knowledge: true,
              plugins: false,
              web: false,
            },
            attachments: [],
          };
          await sql`INSERT INTO work_task_scopes(task_id,scope,scope_digest) VALUES(${task},${JSON.stringify(scope)}::jsonb,${hash(scope)})`;
          return { task, run };
        };
        const root = await native(first.id, [second.id]),
          child = await native(second.id, []),
          action = randomUUID();
        await sql`INSERT INTO work_events(task_id,revision,kind,payload,created_at) VALUES(${root.task},1,'run.claimed',${JSON.stringify({ runId: root.run, epoch: 1 })}::jsonb,'2035-01-01T00:00:00.123456Z')`;
        await sql`INSERT INTO work_actions(id,task_id,run_id,action_key,intent,intent_digest,authority_generation,requires_approval,decision,expires_at,reserved_tokens,status,baseline_requires_approval,actual_tokens,evidence) VALUES(${action},${root.task},${root.run},'fixture','{}'::jsonb,${"d".repeat(64)},1,false,'not_required','2035-01-01T00:05:00Z',0,'applied',false,0,'{}'::jsonb)`;
        await sql`INSERT INTO work_collaborations(creation_action_id,intent_digest,parent_task_id,parent_work_run_id,child_task_id,child_work_run_id,root_task_id,root_work_run_id,depth,deadline_at,source_kind) VALUES(${action},${"d".repeat(64)},${root.task},${root.run},${child.task},${child.run},${root.task},${root.run},1,'2035-01-01T00:05:00.123456Z','task')`;
        for (const implementation of ["ts", "python"]) {
          if (implementation === "python") {
            await options.restorePython();
            await options.reverseToPython();
          }
          const channel = randomUUID();
          channels.push(channel);
          await sql`INSERT INTO channels(id,name,description) VALUES(${channel},${"Deletion " + randomUUID()},'Synthetic')`;
          await sql`INSERT INTO messages(id,channel_id,author_type,content) VALUES(${randomUUID()},${channel},'human','Unreferenced private fixture')`;
          const result = await request("/api/v1/channels/" + channel, "DELETE");
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal((await sql`SELECT id FROM messages WHERE channel_id=${channel}`).length, 0);
        }
        await options.restoreTs();
        await options.stopPython();
      },
    );
    await check(
      "deletion clears primary preference and keeps committed identity facts through paired reverse",
      async () => {
        const bot = await ordinary();
        const channel = await conversation(bot.id);
        await sql`UPDATE workspace_settings SET primary_bot_id=${bot.id} WHERE workspace_id='workspace'`;
        const result = await request("/api/v1/bots/" + bot.id, "DELETE");
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.attachmentsRemoved, true);
        assert.equal(result.body.pluginGrantsRemoved, true);
        assert.equal(
          (
            await sql`SELECT primary_bot_id FROM workspace_settings WHERE workspace_id='workspace'`
          )[0]!.primary_bot_id,
          null,
        );
        assert((await sql`SELECT deleted_at FROM channels WHERE id=${channel}`)[0]!.deleted_at);
        await options.restorePython();
        await options.reverseToPython();
        const list = await request("/api/v1/bots");
        assert.equal(list.status, 200);
        assert(!list.body.bots.some((b: any) => b.id === bot.id));
        const added = await ordinary();
        await options.restoreTs();
        assert((await request("/api/v1/bots")).body.bots.some((b: any) => b.id === added.id));
      },
    );
    console.log(
      `Identity lifecycle ownership passed: ${passed}; synthetic SDK transport, no paid call or engine execution.`,
    );
  } finally {
    for (const service of greetings) await service.close();
    await store.close();
    if (prior !== undefined)
      await sql`UPDATE owner_preferences SET default_model=${prior === null ? null : JSON.stringify(prior)}::jsonb WHERE owner_id='owner'`;
    await database.close();
  }
}
