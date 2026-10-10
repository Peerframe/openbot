// @vitest-environment jsdom
import { frozenWebContracts } from "../../../scripts/frozen-web-contracts.ts";
import { workHttpOpenApi, workHttpOperations, workHttpSchemas } from "@openbot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import {
  type CreateWorkInput,
  cancelWorkTask,
  createWorkInputSchema,
  createWorkTask,
  getWorkTask,
  workSnapshotSchema,
} from "../src/work-api";

const fixtures = frozenWebContracts<{
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
  wireCases: {
    schema: keyof typeof workHttpSchemas;
    name: string;
    input: unknown;
    valid: boolean;
    serialized?: unknown;
  }[];
}>("work");
afterEach(() => vi.unstubAllGlobals());

it.each(fixtures.wireCases)("TS wire/frozen Python DTO parity: $schema/$name", (sample) => {
  const result = workHttpSchemas[sample.schema].safeParse(sample.input);
  expect(result.success).toBe(sample.valid);
  if (result.success) expect(result.data).toEqual(sample.serialized);
});

it("retains all frozen Work route methods, operation IDs and successful statuses", () => {
  const python = frozenWebContracts<{ paths: Record<string, Record<string, { operationId: string; responses: object }>> }>("workOpenApi");
  const actual = Object.entries(python.paths).flatMap(([path, methods]) =>
    Object.entries(methods as Record<string, { operationId: string; responses: object }>).map(
      ([method, operation]) => ({
        path,
        method,
        operationId: operation.operationId,
        status: Number(Object.keys(operation.responses).find((status) => /^2/.test(status))),
      }),
    ),
  );
  expect(
    workHttpOperations.map(({ path, method, operationId, status }) => ({
      path,
      method,
      operationId,
      status,
    })),
  ).toEqual(expect.arrayContaining(actual));
  expect(actual).toHaveLength(workHttpOperations.length);
  expect(Object.keys(workHttpOpenApi().paths)).toHaveLength(actual.length);
});

it.each(fixtures.cases)("frozen Python and runtime Web validation agree: $name", (sample) => {
  const result = workSnapshotSchema.safeParse(sample.input);
  expect(result.success).toBe(sample.valid);
  if (sample.valid) expect(workSnapshotSchema.safeParse(sample.serialized).success).toBe(true);
});

it.each(fixtures.requests)("request DTO and runtime Web validation agree: $name", (sample) => {
  expect(createWorkInputSchema.safeParse(sample.input).success).toBe(sample.valid);
  if (sample.valid) expect(createWorkInputSchema.safeParse(sample.serialized).success).toBe(true);
});

it.each(fixtures.commands)(
  "consumes frozen actual $operation HTTP status $status: $id",
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
  "consumes frozen HTTP route serialization/status: $id",
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
