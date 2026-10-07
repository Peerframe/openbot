import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  controlHttpSchemas,
  lifecycleHttpSchemas,
  resourceHttpSchemas,
  employeeHttpSchemas,
  automationHttpSchemas,
  nodeHttpSchemas,
  pluginHttpSchemas,
  browserHttpSchemas,
  portabilityHttpSchemas,
} from "@openbot/protocol";
import { expect, it } from "vitest";

const schemas = {
  ...controlHttpSchemas,
  ...resourceHttpSchemas,
  ...lifecycleHttpSchemas,
  ...employeeHttpSchemas,
  ...automationHttpSchemas,
  ...nodeHttpSchemas,
  ...pluginHttpSchemas,
  ...browserHttpSchemas,
  ...portabilityHttpSchemas,
};
type Sample = {
  schema: keyof typeof schemas;
  name: string;
  input: unknown;
  valid: boolean;
  serialized?: unknown;
};
const root = resolve(process.cwd(), "../..");
const fixtures = JSON.parse(
  execFileSync(
    `${root}/apps/server-python/.venv/bin/python`,
    ["-I", "-B", `${root}/apps/server-python/scripts/control-contract-fixtures.py`],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin" },
    },
  ),
) as { projections: Sample[]; requests: Sample[] };

it.each(fixtures.requests)("TS/Python input normalization: $schema/$name", (sample) => {
  const result = schemas[sample.schema].safeParse(sample.input);
  expect(result.success).toBe(sample.valid);
  if (result.success) expect(result.data).toEqual(sample.serialized);
});
it.each(fixtures.projections)(
  "TS consumes actual Python serialization: $schema/$name",
  (sample) => {
    const result = schemas[sample.schema].safeParse(
      sample.valid ? sample.serialized : sample.input,
    );
    expect(result.success).toBe(sample.valid);
    if (result.success) expect(result.data).toEqual(sample.serialized);
  },
);

it("retains the existing identity/profile/task/rename differential fixture gate", () => {
  const output = execFileSync(
    process.execPath,
    [`${root}/apps/server-python/scripts/compare-identity-inputs.ts`],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin" },
    },
  );
  expect(output).toMatch(/171/);
});
