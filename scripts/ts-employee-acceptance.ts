import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase } from "@openbot/db";

export async function qualifyEmployeeOwnership(options: {
  databaseUrl: string;
  origin: string;
  privateOrigin: string;
  cookie: string;
  stopPython(): Promise<void>;
  restorePython(): Promise<void>;
  reverseToPython(): Promise<void>;
  restoreTs(): Promise<void>;
}) {
  const database = createDatabase(options.databaseUrl),
    sql = database.client,
    bot = randomUUID(),
    childBot = randomUUID();
  const base = `/api/v1/bots/${bot}`;
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
      signal: AbortSignal.timeout(10000),
    });
    const raw = await response.text();
    return { status: response.status, body: JSON.parse(raw) };
  };
  let passed = 0;
  const check = async (name: string, work: () => Promise<void>) => {
    await work();
    passed++;
    console.log("employee-ownership: " + name);
  };
  const profile = async () => {
    const r = await request(base + "/profile");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.profile;
  };
  const unicodeMarkdown = `---\nname: unicode-${bot}\ndescription: ${"😀".repeat(700)}\n---\nSafe evidence.\n`;
  const memory = {
    kind: "semantic",
    title: "Owned fact",
    content: "Synthetic safe fact",
    sensitivity: "internal",
    portability: "never",
    modelUseEnabled: false,
  };
  const hash = (v: any): string => {
    const sort = (x: any): any =>
      Array.isArray(x)
        ? x.map(sort)
        : x && typeof x === "object"
          ? Object.fromEntries(
              Object.keys(x)
                .sort()
                .map((k) => [k, sort(x[k])]),
            )
          : x;
    return createHash("sha256")
      .update(JSON.stringify(sort(v)))
      .digest("hex");
  };
  const native = async (botId: string, collaboratorBotIds: string[] = []) => {
    const task = randomUUID(),
      run = randomUUID(),
      proposal = randomUUID();
    await sql`INSERT INTO work_tasks(id,owner_id,bot_id,request_key,request_digest,objective,token_limit,status,authority_active,completion_digest) VALUES(${task},'owner',${botId},${randomUUID()},${"a".repeat(64)},'Synthetic Employee source',0,'completed',false,${"b".repeat(64)})`;
    await sql`INSERT INTO work_runs(id,task_id,ordinal,status) VALUES(${run},${task},1,'completed')`;
    const digest = hash({
      kind: "work_task_profile",
      version: 1,
      taskId: task,
      botId,
      executionProfile: "none",
      modelSelection: null,
    });
    await sql`INSERT INTO work_task_profiles(task_id,bot_id,execution_profile,model_selection,profile_digest) VALUES(${task},${botId},'none',NULL,${digest})`;
    const scope = {
      version: 1,
      taskId: task,
      botId,
      request: {
        version: 1,
        attachmentIds: [],
        collaboratorBotIds,
        knowledge: true,
        plugins: false,
        web: false,
      },
      attachments: [],
    };
    await sql`INSERT INTO work_task_scopes(task_id,scope,scope_digest) VALUES(${task},${JSON.stringify(scope)}::jsonb,${hash(scope)})`;
    await sql`INSERT INTO knowledge_proposals(id,bot_id,source_kind,source_work_run_id,kind,title,content) VALUES(${proposal},${botId},'task',${run},'procedural','Synthetic proposal','Safe candidate')`;
    return { task, run, proposal, digest, scope };
  };
  try {
    await sql`INSERT INTO bots(id,name,role,status,computer_profile) VALUES(${bot},${"Knowledge " + bot},'Synthetic','idle','none'),(${childBot},${"Knowledge child " + childBot},'Synthetic','idle','none')`;
    await check("private knowledge routes refuse every second public owner", async () => {
      for (const [method, suffix] of [
        ["GET", "/profile"],
        ["POST", "/skills"],
        ["POST", "/skills/import"],
        ["POST", "/skills/fixture/state"],
        ["POST", "/memories"],
        ["PATCH", "/memories/fixture"],
        ["DELETE", "/memories/fixture"],
        ["GET", "/knowledge-proposals"],
        ["POST", "/knowledge-proposals/fixture/review"],
      ]) {
        const r = await request(
          base + suffix,
          method!,
          method === "GET" ? undefined : {},
          options.privateOrigin,
        );
        assert.equal(r.status, 503);
        assert.equal(r.body.error, "operation_owned_by_ts");
      }
    });
    await check("authentication and Origin remain ahead of knowledge parsing", async () => {
      assert.equal((await request(base + "/memories", "POST", {}, options.origin, "")).status, 401);
      const r = await fetch(options.origin + base + "/skills", {
        method: "POST",
        headers: {
          Cookie: options.cookie,
          Origin: "https://foreign.invalid",
          "Content-Type": "application/json",
        },
        body: "broken",
      });
      assert.equal(r.status, 403);
    });
    await options.stopPython();
    let memoryId = "";
    await check("memory and digest-reviewed skills work with Python stopped", async () => {
      const created = await request(base + "/memories", "POST", memory);
      assert.equal(created.status, 201);
      memoryId = created.body.memory.id;
      const slug = "fixture-" + randomUUID(),
        markdown = `---\nname: ${slug}\ndescription: Read safe evidence\n---\nUse only reviewed facts.\n`;
      const imported = await request(base + "/skills/import", "POST", {
        markdown,
        version: "1.0.0",
        reason: "Synthetic Owner review",
      });
      assert.equal(imported.status, 201, JSON.stringify(imported.body));
      const reviewed = await request(base + `/skills/${imported.body.skill.id}/state`, "POST", {
        state: "verified",
        confidence: 100,
        ownerReviewed: true,
        reviewedContentSha256: imported.body.skill.contentSha256,
        reason: "Synthetic reviewed content",
      });
      assert.equal(reviewed.status, 200);
      assert.equal(reviewed.body.skill.modelUseEnabled, true);
      const p = await profile();
      assert.equal(p.memories.length, 1);
      assert.equal(p.skills.length, 1);
    });
    await check("failed memory history insertion rolls the mutable row back", async () => {
      const before = await profile();
      await sql.unsafe(
        `ALTER TABLE employee_memory_events ADD CONSTRAINT ts_employee_fixture CHECK (bot_id <> '${bot}') NOT VALID`,
      );
      try {
        const r = await request(base + `/memories/${memoryId}`, "PATCH", {
          expectedRevision: 1,
          title: "Must roll back",
        });
        assert.equal(r.status, 503);
        assert.deepEqual(await profile(), before);
      } finally {
        await sql`ALTER TABLE employee_memory_events DROP CONSTRAINT ts_employee_fixture`;
      }
    });
    await check("non-BMP skill metadata preserves the Python code-point contract", async () => {
      const r = await request(base + "/skills/import", "POST", {
        markdown: unicodeMarkdown,
        version: "1.0.0",
        reason: "Unicode fixture",
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.skill.description, "😀".repeat(700));
    });
    const source = await native(bot);
    await check(
      "native profile and scope digests refuse changed source before review",
      async () => {
        const path = base + `/knowledge-proposals/${source.proposal}/review`,
          body = {
            decision: "accept",
            ownerReviewed: true,
            title: "Reviewed",
            content: "Safe reviewed procedure",
            modelUseEnabled: true,
          };
        await sql`UPDATE work_task_profiles SET profile_digest=${"0".repeat(64)} WHERE task_id=${source.task}`;
        assert.equal((await request(path, "POST", body)).status, 409);
        await sql`UPDATE work_task_profiles SET profile_digest=${source.digest} WHERE task_id=${source.task}`;
        await sql`UPDATE work_task_scopes SET scope_digest=${"0".repeat(64)} WHERE task_id=${source.task}`;
        assert.equal((await request(path, "POST", body)).status, 409);
        await sql`UPDATE work_task_scopes SET scope_digest=${hash(source.scope)} WHERE task_id=${source.task}`;
        const r = await request(path, "POST", body);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const [row] =
          await sql`SELECT provenance FROM employee_memories WHERE id=${r.body.memoryId}`;
        assert.equal(row!.provenance.sourceTaskId, source.task);
      },
    );
    await check(
      "native child review retains narrowed scope, root lock and exact deadline",
      async () => {
        const root = await native(bot, [childBot]),
          child = await native(childBot),
          action = randomUUID();
        await sql`INSERT INTO work_events(task_id,revision,kind,payload,created_at) VALUES(${root.task},1,'run.claimed',${JSON.stringify({ runId: root.run, epoch: 1 })}::jsonb,'2035-01-01T00:00:00.123456Z')`;
        await sql`INSERT INTO work_actions(id,task_id,run_id,action_key,intent,intent_digest,authority_generation,requires_approval,decision,expires_at,reserved_tokens,status,baseline_requires_approval,actual_tokens,evidence) VALUES(${action},${root.task},${root.run},'fixture','{}'::jsonb,${"d".repeat(64)},1,false,'not_required','2035-01-01T00:05:00Z',0,'applied',false,0,'{}'::jsonb)`;
        await sql`INSERT INTO work_collaborations(creation_action_id,intent_digest,parent_task_id,parent_work_run_id,child_task_id,child_work_run_id,root_task_id,root_work_run_id,depth,deadline_at,source_kind) VALUES(${action},${"d".repeat(64)},${root.task},${root.run},${child.task},${child.run},${root.task},${root.run},1,'2035-01-01T00:05:00.123456Z','task')`;
        const path = `/api/v1/bots/${childBot}/knowledge-proposals/${child.proposal}/review`,
          body = { decision: "reject", ownerReviewed: true };
        const changed = { ...child.scope, request: { ...child.scope.request, web: true } };
        await sql`UPDATE work_task_scopes SET scope=${JSON.stringify(changed)}::jsonb,scope_digest=${hash(changed)} WHERE task_id=${child.task}`;
        assert.equal((await request(path, "POST", body)).status, 409);
        await sql`UPDATE work_task_scopes SET scope=${JSON.stringify(child.scope)}::jsonb,scope_digest=${hash(child.scope)} WHERE task_id=${child.task}`;
        await sql`UPDATE work_collaborations SET deadline_at=deadline_at+interval '1 microsecond' WHERE creation_action_id=${action}`;
        assert.equal((await request(path, "POST", body)).status, 409);
        await sql`UPDATE work_collaborations SET deadline_at=deadline_at-interval '1 microsecond' WHERE creation_action_id=${action}`;
        const r = await request(path, "POST", body);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.memoryId, null);
      },
    );
    const before = await profile();
    await options.restorePython();
    await options.reverseToPython();
    await check(
      "Python reverse reads TS skills, memory provenance and history exactly",
      async () => {
        assert.deepEqual(await profile(), before);
        const imported = await request(`/api/v1/bots/${childBot}/skills/import`, "POST", {
          markdown: unicodeMarkdown,
          version: "1.0.0",
          reason: "Reverse Unicode fixture",
        });
        assert.equal(imported.status, 201);
        const r = await request(base + `/memories/${memoryId}`, "PATCH", {
          expectedRevision: 1,
          title: "Python revised",
        });
        assert.equal(r.status, 200);
        const original = await native(bot),
          path = base + `/knowledge-proposals/${original.proposal}/review`;
        await sql`UPDATE work_task_profiles SET profile_digest=${"0".repeat(64)} WHERE task_id=${original.task}`;
        const refused = await request(path, "POST", { decision: "reject", ownerReviewed: true });
        assert.equal(refused.status, 409);
        assert.equal(refused.body.error, "product_task_profile_changed");
        await sql`UPDATE work_task_profiles SET profile_digest=${original.digest} WHERE task_id=${original.task}`;
        assert.equal(
          (await request(path, "POST", { decision: "reject", ownerReviewed: true })).status,
          200,
        );
      },
    );
    const reversed = await profile();
    await options.restoreTs();
    await check(
      "TS resumes the same revised memory and Python-reviewed native source",
      async () => {
        assert.deepEqual(await profile(), reversed);
      },
    );
    await check(
      "oversized persisted profile content fails inside SQL without returning the body",
      async () => {
        await sql`UPDATE bots SET configuration=${JSON.stringify({ privateFixture: "x".repeat(4 * 1024 * 1024 + 1) })}::jsonb WHERE id=${bot}`;
        try {
          const r = await request(base + "/profile");
          assert.equal(r.status, 503);
          assert.equal(r.body.error, "employee_knowledge_projection_limit");
        } finally {
          await sql`UPDATE bots SET configuration='{}'::jsonb WHERE id=${bot}`;
        }
      },
    );
    console.log(`Employee P3 ownership acceptance passed: ${passed} checks.`);
  } finally {
    await database.close();
  }
}
