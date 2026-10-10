/** Real Server scenario; synthetic rows and peers are restricted to its owned fixture. */
import { scenarioStep as check } from "./scenario-step.ts";
import assert from "node:assert/strict";
import { createDatabase } from "@openbot/db";
import { modelConnectionResponseSchema, modelServicesSnapshotSchema } from "@openbot/protocol";
export async function qualifyModelOwnership(options: {
  databaseUrl: string;
  origin: string;
  cookie: string;
  restart(): Promise<void>;
}) {
  const database = createDatabase(options.databaseUrl),
    sql = database.client;
  const create = {
    name: "Synthetic migration connection",
    presetId: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "migration-fixture-value",
  };
  const call = async (path: string, method = "GET", body?: unknown, cookie = options.cookie) => {
    const response = await fetch(options.origin + path, {
      method,
      headers: {
        Origin: options.origin,
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    return { status: response.status, body: await response.json() };
  };
  let id = "";
  try {

    await check(
      "authentication precedes body validation and no endpoint is caller-authorized",
      async () => {
        assert.equal((await call("/api/v1/model-connections", "POST", {}, "")).status, 401);
        assert.equal(
          (await call("/api/v1/model-connections", "POST", { ...create, presetId: "custom" }))
            .status,
          422,
        );
        assert.equal(
          (
            await call("/api/v1/model-connections/verify", "POST", {
              presetId: "missing",
              baseUrl: create.baseUrl,
              apiKey: create.apiKey,
            })
          ).status,
          422,
        );
        const response = await fetch(options.origin + "/api/v1/model-connections", {
          method: "POST",
          headers: { Cookie: options.cookie, "Content-Type": "application/json" },
          body: "{",
        });
        assert.equal(response.status, 403);
        await response.arrayBuffer();
      },
    );
    await check("TS creates one encrypted record and never exposes its secret", async () => {
      const response = await call("/api/v1/model-connections", "POST", create);
      assert.equal(response.status, 201);
      id = modelConnectionResponseSchema.parse(response.body).connection.id;
      const [stored] =
        await sql`SELECT encrypted_api_key,revision FROM model_connections WHERE id=${id}`;
      assert.match(stored!.encrypted_api_key, /^v1\./);
      assert(!stored!.encrypted_api_key.includes(create.apiKey));
      assert(!JSON.stringify((await call("/api/v1/model-services")).body).includes(create.apiKey));
      const [audit] =
        await sql`SELECT payload FROM run_events WHERE type='MODEL_CONNECTION_CREATED' AND payload->>'id'=${id}`;
      assert.deepEqual(audit!.payload, { id, presetId: "openai", revision: 1 });
    });
    await check(
      "concurrent CAS has one winner and one audit, and no-op preserves revision",
      async () => {
        const results = await Promise.all(
          ["First", "Second"].map((name) =>
            call(`/api/v1/model-connections/${id}`, "PATCH", { name, expectedRevision: 1 }),
          ),
        );
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        const winner = modelConnectionResponseSchema.parse(
          results.find((r) => r.status === 200)!.body,
        ).connection;
        const repeat = await call(`/api/v1/model-connections/${id}`, "PATCH", {
          name: winner.name,
          expectedRevision: 2,
        });
        assert.equal(modelConnectionResponseSchema.parse(repeat.body).connection.revision, 2);
        assert.equal(
          (
            await sql`SELECT id FROM run_events WHERE type='MODEL_CONNECTION_UPDATED' AND payload->>'id'=${id}`
          ).length,
          1,
        );
      },
    );
    await check("audit failure rolls the key replacement and revision back together", async () => {
      const before =
        await sql`SELECT encrypted_api_key,revision FROM model_connections WHERE id=${id}`;
      await sql`CREATE FUNCTION openbot_p3_model_fail() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.type = ''MODEL_CONNECTION_UPDATED'' THEN RAISE EXCEPTION ''synthetic audit refusal''; END IF; RETURN NEW; END'`;
      await sql`CREATE TRIGGER openbot_p3_model_fail BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION openbot_p3_model_fail()`;
      try {
        assert.equal(
          (
            await call(`/api/v1/model-connections/${id}`, "PATCH", {
              apiKey: "replacement-fixture-value",
              expectedRevision: 2,
            })
          ).status,
          503,
        );
        assert.deepEqual(
          await sql`SELECT encrypted_api_key,revision FROM model_connections WHERE id=${id}`,
          before,
        );
      } finally {
        await sql`DROP TRIGGER openbot_p3_model_fail ON run_events`;
        await sql`DROP FUNCTION openbot_p3_model_fail()`;
      }
    });
    await check("model reads and updates remain available with a restarted Server", async () => {
      await options.restart();
      try {
        assert.equal((await call("/api/v1/model-services")).status, 200);
        assert.equal(
          (
            await call(`/api/v1/model-connections/${id}`, "PATCH", {
              enabled: false,
              expectedRevision: 2,
            })
          ).status,
          200,
        );
        assert.equal((await call("/api/v1/settings/general")).status, 200);
      } finally {
        await options.restart();
      }
    });
    await check(
      "process restart preserves TS data, and TS reads subsequent Server key replacement",
      async () => {
        await options.restart();
        try {
          const read = modelServicesSnapshotSchema
            .parse((await call("/api/v1/model-services")).body)
            .connections.find((c) => c.id === id)!;
          assert.equal(read.revision, 3);
          assert.equal(read.enabled, false);
          assert.equal(
            (
              await call(`/api/v1/model-connections/${id}`, "PATCH", {
                enabled: true,
                apiKey: "reverse-fixture-value",
                expectedRevision: 3,
              })
            ).status,
            200,
          );
        } finally {
          await options.restart();
        }
        const read = modelServicesSnapshotSchema
          .parse((await call("/api/v1/model-services")).body)
          .connections.find((c) => c.id === id)!;
        assert.equal(read.revision, 4);
        assert.equal(read.enabled, true);
        const before = await call("/api/v1/settings/transcription");
        assert(before.body && typeof before.body === "object" && "revision" in before.body);
        assert.equal(
          (
            await call("/api/v1/settings/transcription", "PUT", {
              expectedRevision: before.body.revision,
              connectionId: id,
            })
          ).status,
          200,
        );
        const conflict = await call(`/api/v1/model-connections/${id}`, "DELETE", {
          expectedRevision: 4,
        });
        assert.equal(conflict.status, 409);
        assert(
          conflict.body &&
            typeof conflict.body === "object" &&
            "transcription" in conflict.body &&
            conflict.body.transcription === true,
        );
        const current = await call("/api/v1/settings/transcription");
        assert(current.body && typeof current.body === "object" && "revision" in current.body);
        assert.equal(
          (
            await call("/api/v1/settings/transcription", "PUT", {
              expectedRevision: current.body.revision,
              connectionId: null,
            })
          ).status,
          200,
        );
        assert.equal(
          (await call(`/api/v1/model-connections/${id}`, "DELETE", { expectedRevision: 4 })).status,
          200,
        );
      },
    );

  } finally {
    await database.close();
  }
}
