// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  cancelWorkTask,
  createWorkTask,
  createWorkInputSchema,
  getWorkTask,
  workSnapshotSchema,
  type CreateWorkInput,
} from "../src/work-api";

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
  requests: { name: string; input: unknown; valid: boolean; serialized?: unknown }[];
  commands: {
    operation: string;
    id: string;
    input: CreateWorkInput;
    status: number;
    body: unknown;
  }[];
};
afterEach(() => vi.unstubAllGlobals());

it.each(fixtures.cases)("Python and runtime Web validation agree: $name", (sample) => {
  const result = workSnapshotSchema.safeParse(sample.input);
  expect(result.success).toBe(sample.valid);
  if (sample.valid) expect(workSnapshotSchema.safeParse(sample.serialized).success).toBe(true);
});

it.each(fixtures.requests)("request DTO and runtime Web validation agree: $name", (sample) => {
  expect(createWorkInputSchema.safeParse(sample.input).success).toBe(sample.valid);
  if (sample.valid) expect(createWorkInputSchema.safeParse(sample.serialized).success).toBe(true);
});

it.each(fixtures.commands)(
  "consumes actual $operation HTTP status $status: $id",
  async (sample) => {
    const fetcher = vi.fn(async () => Response.json(sample.body, { status: sample.status }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    const command =
      sample.operation === "create"
        ? createWorkTask(sample.input, signal)
        : cancelWorkTask(sample.id, signal);
    // Invalid create input is refused locally before a network side effect.
    if (sample.operation === "create" && !createWorkInputSchema.safeParse(sample.input).success) {
      await expect(command).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
      expect([413, 422]).toContain(sample.status);
    } else if (sample.status >= 400) {
      await expect(command).rejects.toMatchObject({ status: sample.status });
      await expect(command).rejects.not.toThrow(/private create diagnostic/);
    } else {
      const result = await command;
      expect(result.id).toBe("task-one");
      if (sample.operation === "cancel") expect(result.cancelRequested).toBe(true);
      else expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(sample.input);
    }
  },
);

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
