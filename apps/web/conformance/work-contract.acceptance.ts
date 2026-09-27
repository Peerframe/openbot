// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getWorkTask, workSnapshotSchema } from "../src/work-api";

const root = `${resolve(process.cwd(), "../..")}/`;
const fixtures = JSON.parse(
  execFileSync(
    `${root}apps/server-python/.venv/bin/python`,
    ["-I", `${root}apps/server-python/scripts/work-contract-fixtures.py`],
    { encoding: "utf8" },
  ),
) as {
  cases: { name: string; input: unknown; valid: boolean; serialized?: unknown }[];
  responses: { id: string; status: number; body: unknown }[];
};
afterEach(() => vi.unstubAllGlobals());

it.each(fixtures.cases)("Python and runtime Web validation agree: $name", (sample) => {
  const result = workSnapshotSchema.safeParse(sample.input);
  expect(result.success).toBe(sample.valid);
  if (sample.valid) expect(workSnapshotSchema.safeParse(sample.serialized).success).toBe(true);
});

it.each(fixtures.responses)(
  "consumes the real HTTP route serialization/status: $id",
  async (sample) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(sample.body, { status: sample.status })),
    );
    const operation = getWorkTask(sample.id, new AbortController().signal);
    if (sample.status === 200) {
      const result = await operation;
      expect(result.actions[0]?.status).toBe("unknown");
      expect(result.actions[0]?.reconciliation).toBeNull();
      expect(result.resultSummary).toBeNull();
      expect(result.objective).toBe("Read 文档");
    } else {
      await expect(operation).rejects.toMatchObject({ status: sample.status });
    }
  },
);
