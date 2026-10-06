import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  controlHttpErrorSchema,
  discoveredModelsSchema,
  modelConnectionDeletionSchema,
  modelConnectionResponseSchema,
  modelConnectionTestSchema,
  modelServicesSnapshotSchema,
} from "@openbot/protocol";
import { contractClient, type RequestOptions } from "./client.ts";
import { type ContractTarget, contractTargetSchema } from "./target.ts";

/** Owner HTTP/SQL/SDK contracts using an explicitly configured synthetic provider transport. */
export async function runModelContracts(input: ContractTarget) {
  const target = contractTargetSchema.parse(input),
    { request } = contractClient(target),
    passed: string[] = [];
  const owned = new Map<string, number>();
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    passed.push(name);
  };
  const error = async (path: string, status: number, options: RequestOptions, code?: string) => {
    const result = await request(path, options);
    assert.equal(result.response.status, status);
    const value = controlHttpErrorSchema.parse(result.body);
    if (code) assert.equal(value.error, code);
    assert(
      !JSON.stringify(result.body).includes("synthetic-contract-") &&
        !JSON.stringify(result.body).includes("Synthetic private provider diagnostic"),
    );
  };
  const snapshot = async () => {
    const value = await request("/api/v1/model-services");
    assert.equal(value.response.status, 200);
    return modelServicesSnapshotSchema.parse(value.body);
  };
  const baseline = await snapshot();
  const discovered = (body: unknown) => {
    const value = discoveredModelsSchema.parse(body).models;
    assert.equal(value.length, 256);
    assert.equal(value[0], "contract/model");
    assert.equal(new Set(value).size, value.length);
    assert(!value.some((id) => id.includes("synthetic-contract-") || /\s/.test(id)));
    return value;
  };
  try {
    for (const presetId of ["openai", "anthropic"]) {
      const preset = baseline.presets.find((item) => item.id === presetId),
        baseUrl = preset?.endpoints[0]?.baseUrl;
      assert(baseUrl);
      const value = { presetId, baseUrl, apiKey: "synthetic-contract-success" };
      await check(
        `${presetId} discovery enforces Owner and Origin before provider dispatch`,
        async () => {
          for (const [status, options] of [
            [401, { cookie: false }],
            [403, { origin: "https://foreign.invalid" }],
          ] as const)
            await error("/api/v1/model-connections/verify", status, {
              method: "POST",
              rawBody: "invalid",
              ...options,
            });
        },
      );
      await check(
        `${presetId} unsaved verification filters and bounds IDs without persisting credentials`,
        async () => {
          const before = await snapshot();
          const result = await request("/api/v1/model-connections/verify", {
            method: "POST",
            body: value,
          });
          assert.equal(result.response.status, 200);
          discovered(result.body);
          assert.deepEqual((await snapshot()).connections, before.connections);
        },
      );
      const created = await request("/api/v1/model-connections", {
        method: "POST",
        body: { ...value, name: `Model HTTP ${randomUUID()}` },
      });
      assert.equal(created.response.status, 201);
      const connection = modelConnectionResponseSchema.parse(created.body).connection;
      owned.set(connection.id, connection.revision);
      const path = `/api/v1/model-connections/${connection.id}`;
      await check(`${presetId} saved discovery uses the same bounded public response`, async () => {
        const result = await request(path + "/models", { method: "POST" });
        assert.equal(result.response.status, 200);
        discovered(result.body);
        assert(!JSON.stringify(created.body).includes(value.apiKey));
      });
      await check(`${presetId} explicit one-step no-tool SDK probe returns only ok`, async () => {
        const result = await request(path + "/test", {
          method: "POST",
          body: { modelId: "contract/model" },
        });
        assert.equal(result.response.status, 200);
        assert.deepEqual(modelConnectionTestSchema.parse(result.body), { ok: true });
      });
      await check(
        `${presetId} probe admission refuses extra fields and unknown connection`,
        async () => {
          await error(path + "/test", 422, {
            method: "POST",
            body: { modelId: "contract/model", tools: ["unsafe"] },
          });
          await error(`/api/v1/model-connections/${randomUUID()}/test`, 404, {
            method: "POST",
            body: { modelId: "contract/model" },
          });
        },
      );
      await check(
        `${presetId} provider credential failure is sanitized and saved state remains unchanged`,
        async () => {
          const result = await request(path, {
            method: "PATCH",
            body: {
              expectedRevision: connection.revision,
              apiKey: "synthetic-contract-credentials",
            },
          });
          assert.equal(result.response.status, 200);
          const changed = modelConnectionResponseSchema.parse(result.body).connection;
          owned.set(changed.id, changed.revision);
          await error(path + "/models", 422, { method: "POST" }, "model_credentials_invalid");
          await error(
            path + "/test",
            422,
            { method: "POST", body: { modelId: "contract/model" } },
            "model_provider_unavailable",
          );
          assert.equal(
            (await snapshot()).connections.find((item) => item.id === changed.id)?.revision,
            changed.revision,
          );
        },
      );
    }
    const openai = baseline.presets.find((item) => item.id === "openai")?.endpoints[0]?.baseUrl;
    assert(openai);
    for (const mode of ["redirect", "invalid-json", "oversize", "failure"])
      await check(
        `unsaved discovery refuses ${mode} without saving credentials or private provider data`,
        async () => {
          await error(
            "/api/v1/model-connections/verify",
            422,
            {
              method: "POST",
              body: { presetId: "openai", baseUrl: openai, apiKey: `synthetic-contract-${mode}` },
            },
            "model_provider_unavailable",
          );
        },
      );
    await check(
      "operator endpoint authority cannot come from an unsaved verification body",
      async () => {
        await error(
          "/api/v1/model-connections/verify",
          422,
          {
            method: "POST",
            body: {
              presetId: "custom",
              baseUrl: "https://foreign.invalid/v1",
              apiKey: "synthetic-contract-success",
            },
          },
          "model_endpoint_not_authorized",
        );
      },
    );
  } finally {
    for (const [id, revision] of owned) {
      const result = await request(`/api/v1/model-connections/${id}`, {
        method: "DELETE",
        body: { expectedRevision: revision },
      });
      assert.equal(result.response.status, 200);
      modelConnectionDeletionSchema.parse(result.body);
    }
  }
  await check(
    "all owned saved connections are deleted and verification leaves no credential record",
    async () => {
      assert.deepEqual((await snapshot()).connections, baseline.connections);
    },
  );
  return { count: passed.length, checks: passed };
}
