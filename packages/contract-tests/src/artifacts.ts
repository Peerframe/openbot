import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { controlHttpErrorSchema, workSnapshotWireSchema } from "@openbot/protocol";
import { contractClient } from "./client.ts";
import {
  artifactScenarioSchema,
  contractTargetSchema,
  type ArtifactScenario,
  type ContractTarget,
} from "./target.ts";

/** Published file fixtures qualify HTTP byte/integrity gates, never Worker publication. */
export async function runArtifactContracts(input: ContractTarget, scenario: ArtifactScenario) {
  const target = contractTargetSchema.parse(input),
    artifacts = artifactScenarioSchema.parse(scenario);
  const { request, download } = contractClient(target),
    passed: string[] = [];
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    passed.push(name);
  };
  const path = (id: string) => `/api/v1/artifacts/${encodeURIComponent(id)}/content`;
  await check("Owner authorization precedes artifact lookup", async () => {
    const first = artifacts.valid[0];
    assert(first);
    for (const id of [first.id, randomUUID()]) {
      const result = await request(path(id), { cookie: false });
      assert.equal(result.response.status, 401);
      controlHttpErrorSchema.parse(result.body);
    }
  });
  for (const artifact of artifacts.valid)
    await check(`exact published ${artifact.mediaType} bytes and download headers`, async () => {
      const expected = Buffer.from(artifact.base64, "base64"),
        result = await download(path(artifact.id), 5 * 1024 * 1024);
      assert.equal(result.response.status, 200);
      assert.deepEqual(Buffer.from(result.bytes), expected);
      assert.equal(
        createHash("sha256").update(result.bytes).digest("hex"),
        createHash("sha256").update(expected).digest("hex"),
      );
      assert.equal(result.response.headers.get("content-length"), String(expected.length));
      assert(result.response.headers.get("content-type")?.startsWith(artifact.mediaType));
      assert.equal(
        result.response.headers.get("content-disposition"),
        `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name).replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      );
    });
  await check("missing IDs and overlong identifiers are bounded errors", async () => {
    for (const [id, status] of [
      [randomUUID(), 404],
      ["a".repeat(129), 422],
    ] as const) {
      const result = await request(path(id));
      assert.equal(result.response.status, status);
      controlHttpErrorSchema.parse(result.body);
    }
  });
  for (const kind of ["integrity", "refusedKey", "symlink", "oversized"] as const) {
    const id = artifacts[kind];
    if (id === undefined) continue;
    await check(
      `published artifact ${kind} fails closed without returning file bytes`,
      async () => {
        const result = await request(path(id));
        assert.equal(result.response.status, 503);
        controlHttpErrorSchema.parse(result.body);
        assert(!JSON.stringify(result.body).includes("Synthetic private artifact sentinel"));
        assert.equal(result.response.headers.get("content-disposition"), null);
      },
    );
  }
  const native = artifacts.native;
  if (native !== undefined) {
    const path = (id: string) => `/api/v1/artifacts/${encodeURIComponent(id)}`;
    await check("native Work artifact admission checks Owner before file existence", async () => {
      assert(native.valid[0]);
      for (const id of [native.valid[0].id, randomUUID()]) {
        const result = await request(path(id), { cookie: false });
        assert.equal(result.response.status, 401);
        controlHttpErrorSchema.parse(result.body);
      }
    });
    for (const file of native.valid)
      await check(
        `exact native Work ${file.mediaType} bytes, filename and sandbox headers`,
        async () => {
          const result = await download(path(file.id), 8 * 1024 * 1024);
          const expected = Buffer.from(file.base64, "base64");
          assert.equal(result.response.status, 200);
          assert.deepEqual(Buffer.from(result.bytes), expected);
          assert.equal(result.response.headers.get("content-length"), String(expected.length));
          assert(result.response.headers.get("content-type")?.startsWith(file.mediaType));
          assert.equal(
            result.response.headers.get("content-security-policy"),
            "default-src 'none'; sandbox",
          );
          assert.equal(
            result.response.headers.get("content-disposition"),
            `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          );
        },
      );
    await check(
      "native Work snapshot retains artifact metadata and authoritative download links",
      async () => {
        const result = await request(`/api/v1/tasks/${native.taskId}`);
        assert.equal(result.response.status, 200);
        const snapshot = workSnapshotWireSchema.parse(result.body);
        for (const file of native.valid) {
          const metadata = snapshot.artifacts.find((item) => item.id === file.id);
          assert(metadata);
          const bytes = Buffer.from(file.base64, "base64");
          assert.equal(metadata.name, file.name);
          assert.equal(metadata.sizeBytes, bytes.length);
          assert.equal(metadata.sha256, createHash("sha256").update(bytes).digest("hex"));
          assert.equal(metadata.downloadUrl, path(file.id));
        }
      },
    );
    await check("native Work missing/overlong artifact IDs retain bounded errors", async () => {
      for (const [id, status] of [
        [randomUUID(), 404],
        ["a".repeat(129), 422],
      ] as const) {
        const result = await request(path(id));
        assert.equal(result.response.status, status);
        controlHttpErrorSchema.parse(result.body);
      }
    });
    for (const kind of ["integrity", "sizeMismatch", "missing", "symlink", "oversized"] as const) {
      const id = native[kind];
      if (id === undefined) continue;
      await check(`native Work ${kind} refuses bytes without retry or publication`, async () => {
        const result = await request(path(id));
        assert.equal(result.response.status, 503);
        controlHttpErrorSchema.parse(result.body);
        assert(!JSON.stringify(result.body).includes("Synthetic private artifact sentinel"));
        assert.equal(result.response.headers.get("content-disposition"), null);
      });
    }
  }
  return { count: passed.length, passed };
}
