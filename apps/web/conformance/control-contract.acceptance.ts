import { frozenWebContracts } from "../../../scripts/frozen-web-contracts.ts";
import {
  quickCreateBotInputSchema, createBotInputSchema, createChannelInputSchema,
  updateEmployeeProfileDetailsInputSchema, createMessageInputSchema, renameBotInputSchema, renameChannelInputSchema,
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
const fixtures = frozenWebContracts<{ projections: Sample[]; requests: Sample[] }>("control");

it.each(fixtures.requests)("TS/frozen Python input normalization: $schema/$name", (sample) => {
  const result = schemas[sample.schema].safeParse(sample.input);
  expect(result.success).toBe(sample.valid);
  if (result.success) expect(result.data).toEqual(sample.serialized);
});
it.each(fixtures.projections)(
  "TS consumes frozen actual Python serialization: $schema/$name",
  (sample) => {
    const result = schemas[sample.schema].safeParse(
      sample.valid ? sample.serialized : sample.input,
    );
    expect(result.success).toBe(sample.valid);
    if (result.success) expect(result.data).toEqual(sample.serialized);
  },
);

const identitySchemas = {
  quickBot: quickCreateBotInputSchema, bot: createBotInputSchema, channel: createChannelInputSchema,
  profile: updateEmployeeProfileDetailsInputSchema, task: createMessageInputSchema,
  botRename: renameBotInputSchema, channelRename: renameChannelInputSchema,
};
const identities = frozenWebContracts<{ id: string; schema: keyof typeof identitySchemas; input: unknown;
  expected: { ok: boolean; value?: unknown } }[]>("identity");
it("retains all 171 identity/profile/task/rename differential cases", () => {
  expect(identities).toHaveLength(171);
});
it.each(identities)("frozen Python identity normalization: $schema/$id", (sample) => {
  const result = identitySchemas[sample.schema].safeParse(sample.input);
  expect(result.success).toBe(sample.expected.ok);
  if (result.success) expect(result.data).toEqual(sample.expected.value);
});
