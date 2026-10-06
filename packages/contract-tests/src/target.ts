import { z } from "zod";
import { nodeIdSchema, nodeEnrollmentTokenSchema } from "@openbot/protocol";

function origin(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && value === url.origin;
  } catch {
    return false;
  }
}
export const contractTargetSchema = z.strictObject({
  baseUrl: z.string().refine(origin),
  origin: z.string().refine(origin),
  cookie: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => !value.includes("\r") && !value.includes("\n")),
  botId: z.string().uuid(),
});
export const controlContractFixtureSchema = contractTargetSchema.extend({
  password: z
    .string()
    .min(15)
    .max(1024)
    .refine((value) => !/[\ud800-\udfff]/u.test(value)),
});
// Seeded records stand in for Worker publication, never for successful Worker/Temporal execution.
export const workScenarioSchema = z.strictObject({
  taskId: z.string().uuid(),
  intentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  actions: z.strictObject({
    approve: z.string().uuid(),
    reject: z.string().uuid(),
    expired: z.string().uuid(),
    stale: z.string().uuid(),
    unknown: z.string().uuid(),
  }),
});
export const workContractFixtureSchema = contractTargetSchema.extend({
  work: workScenarioSchema.optional(),
});
export const lifecycleScenarioSchema = z.strictObject({
  channelId: z.string().uuid(),
  unreadMessageId: z.string().uuid(),
  approvals: z.strictObject({
    approve: z.string().uuid(),
    reject: z.string().uuid(),
    expired: z.string().uuid(),
  }),
});
export const lifecycleContractFixtureSchema = contractTargetSchema.extend({
  lifecycle: lifecycleScenarioSchema,
});
export const employeeScenarioSchema = z.strictObject({
  botId: z.string().uuid(),
  sourceRunId: z.string().uuid(),
  sourceTaskId: z.string().uuid(),
  sourceWorkRunId: z.string().uuid(),
  proposals: z.strictObject({
    accept: z.string().uuid(),
    reject: z.string().uuid(),
    native: z.string().uuid(),
    incomplete: z.string().uuid(),
  }),
});
export const employeeContractFixtureSchema = contractTargetSchema.extend({
  employee: employeeScenarioSchema,
});
// An already-expired bootstrap token is private fixture data, never a live Worker credential.
export const nodeScenarioSchema = z.strictObject({
  expiredNodeId: nodeIdSchema,
  expiredToken: nodeEnrollmentTokenSchema,
});
export const nodeContractFixtureSchema = contractTargetSchema.extend({ nodes: nodeScenarioSchema });
export const nativeArtifactScenarioSchema = z.strictObject({
  taskId: z.string().uuid(),
  valid: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        name: z.string().min(1).max(255),
        mediaType: z.enum(["text/markdown", "image/png", "application/octet-stream"]),
        base64: z
          .string()
          .max(1024)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      }),
    )
    .min(2)
    .max(3),
  integrity: z.string().uuid(),
  sizeMismatch: z.string().uuid(),
  missing: z.string().uuid(),
  symlink: z.string().uuid().optional(),
  oversized: z.string().uuid(),
});
export const artifactScenarioSchema = z.strictObject({
  valid: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        name: z.string().min(1).max(160),
        mediaType: z.enum(["text/markdown", "image/png"]),
        base64: z
          .string()
          .min(1)
          .max(1024)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
      }),
    )
    .length(2),
  integrity: z.string().uuid(),
  refusedKey: z.string().uuid(),
  // A corrupt symlink invalidates whole-root storage measurement; qualify it in a staged run.
  symlink: z.string().uuid().optional(),
  oversized: z.string().uuid(),
  native: nativeArtifactScenarioSchema.optional(),
});
export const artifactContractFixtureSchema = contractTargetSchema.extend({
  artifacts: artifactScenarioSchema,
});
// Only the explicitly owned loopback MCP fixture accepts this separate controller credential.
export const pluginScenarioSchema = z
  .strictObject({
    endpoint: z.string().refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "http:" &&
          url.hostname === "127.0.0.1" &&
          Boolean(url.port) &&
          value === `${url.origin}/mcp`
        );
      } catch {
        return false;
      }
    }),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    controllerToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((value) => value.token !== value.controllerToken);
export const pluginContractFixtureSchema = contractTargetSchema.extend({
  plugins: pluginScenarioSchema,
});
// An authored one-pixel PNG supplies only synthetic protocol bytes, not browser execution evidence.
export const browserScenarioSchema = z.strictObject({
  frameBase64: z
    .string()
    .min(32)
    .max(1024)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export const browserContractFixtureSchema = contractTargetSchema.extend({
  browser: browserScenarioSchema,
});
// Only public verification metadata crosses into the black-box runner; no keyring paths or secrets.
export const publisherScenarioSchema = z.strictObject({
  keyid: z.string().regex(/^ed25519:[a-f0-9]{64}$/),
  publicKey: z.string().min(1).max(16384),
});
export const publisherContractFixtureSchema = contractTargetSchema.extend({
  publisher: publisherScenarioSchema,
});
export const productContractFixtureSchema = controlContractFixtureSchema.extend({
  work: workScenarioSchema,
  lifecycle: lifecycleScenarioSchema,
  employee: employeeScenarioSchema,
  nodes: nodeScenarioSchema,
  artifacts: artifactScenarioSchema.extend({ native: nativeArtifactScenarioSchema }),
  plugins: pluginScenarioSchema,
  browser: browserScenarioSchema,
});
export type LifecycleScenario = z.infer<typeof lifecycleScenarioSchema>;
export type WorkScenario = z.infer<typeof workScenarioSchema>;
export type EmployeeScenario = z.infer<typeof employeeScenarioSchema>;
export type NodeScenario = z.infer<typeof nodeScenarioSchema>;
export type ArtifactScenario = z.infer<typeof artifactScenarioSchema>;
export type PluginScenario = z.infer<typeof pluginScenarioSchema>;
export type BrowserScenario = z.infer<typeof browserScenarioSchema>;
export type PublisherScenario = z.infer<typeof publisherScenarioSchema>;
export type ContractTarget = z.infer<typeof contractTargetSchema>;
