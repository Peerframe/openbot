import { z } from "zod";
import { executionNodeSchema } from "./control-http.js";
import type { HttpOperation } from "./http-openapi.js";
import {
  createNodeEnrollmentTokenInputSchema,
  exchangeNodeEnrollmentInputSchema,
  nodeEnrollmentResultSchema,
  nodeEnrollmentTokenSchema,
  nodeIdSchema,
} from "./node.js";

/** Public metadata only; credential and throttle digests remain Server-owned. */
export const nodeIdentitySummarySchema = z.strictObject({
  nodeId: nodeIdSchema,
  status: z.enum(["active", "revoked"]),
  connected: z.boolean(),
  enrolledAt: z.string().datetime(),
  lastAuthenticatedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
  node: executionNodeSchema.optional(),
});
export const nodeEnrollmentTokenResponseSchema = z.strictObject({
  nodeId: nodeIdSchema,
  token: nodeEnrollmentTokenSchema,
  expiresAt: z.string().datetime(),
});
export const workerNodesResponseSchema = z.strictObject({ nodes: z.array(executionNodeSchema) });
export const nodeIdentitiesResponseSchema = z.strictObject({
  identities: z.array(nodeIdentitySummarySchema),
});
export const nodeHttpSchemas = {
  CreateNodeEnrollmentTokenInput: createNodeEnrollmentTokenInputSchema,
  ExchangeNodeEnrollmentInput: exchangeNodeEnrollmentInputSchema,
  NodeEnrollmentResult: nodeEnrollmentResultSchema,
  NodeEnrollmentToken: nodeEnrollmentTokenResponseSchema,
  NodeIdentitySummary: nodeIdentitySummarySchema,
  WorkerNodesResponse: workerNodesResponseSchema,
  NodeIdentitiesResponse: nodeIdentitiesResponseSchema,
};
export const nodeHttpOperations: readonly HttpOperation[] = [
  {
    method: "get",
    path: "/api/v1/nodes",
    operationId: "listWorkerNodes",
    status: 200,
    response: "WorkerNodesResponse",
  },
  {
    method: "get",
    path: "/api/v1/node-identities",
    operationId: "listWorkerNodeIdentities",
    status: 200,
    response: "NodeIdentitiesResponse",
  },
  {
    method: "post",
    path: "/api/v1/nodes/enrollment-tokens",
    operationId: "issueWorkerEnrollmentToken",
    status: 201,
    request: "CreateNodeEnrollmentTokenInput",
    response: "NodeEnrollmentToken",
    maxBodyBytes: 8192,
  },
  {
    method: "post",
    path: "/api/v1/nodes/enroll",
    operationId: "exchangeWorkerEnrollment",
    status: 201,
    request: "ExchangeNodeEnrollmentInput",
    response: "NodeEnrollmentResult",
    maxBodyBytes: 8192,
    owner: false,
    origin: false,
    errors: [400, 401, 408, 413, 422, 429, 503],
  },
  {
    method: "post",
    path: "/api/v1/nodes/{node_id}/revoke",
    operationId: "revokeWorkerIdentity",
    status: 204,
  },
];
export type ExecutionNodeWire = z.infer<typeof executionNodeSchema>;
export type NodeIdentitySummaryWire = z.infer<typeof nodeIdentitySummarySchema>;
export type NodeEnrollmentTokenWire = z.infer<typeof nodeEnrollmentTokenResponseSchema>;
