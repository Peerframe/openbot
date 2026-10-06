import { z } from "zod";
import { httpOpenApi } from "./http-openapi.js";
import { nativeTaskScopeRequestSchema, nativeTaskScopeSchema } from "./native-task.js";
import {
  cancelWorkInputSchema,
  correctWorkInputSchema,
  createWorkRequestSchema,
  decideWorkActionInputSchema,
  reconcileWorkInputSchema,
  workActionSchema,
  workArtifactSchema,
  workCorrectionSchema,
  workErrorSchema,
  workEventSchema,
  workHttpErrorSchema,
  workReconciliationSchema,
  workRunSchema,
  workSnapshotWireSchema,
  workUsageSchema,
} from "./work-http.js";

export const workHttpSchemas = {
  CreateTask: createWorkRequestSchema,
  EmptyCommand: cancelWorkInputSchema,
  DecideAction: decideWorkActionInputSchema,
  RequestReconciliation: reconcileWorkInputSchema,
  RequestCorrection: correctWorkInputSchema,
  NativeTaskScope: nativeTaskScopeRequestSchema,
  NativeTaskScopeResponse: z.object({ scope: nativeTaskScopeSchema.nullable() }).strict(),
  WorkCorrection: workCorrectionSchema,
  WorkReconciliation: workReconciliationSchema,
  WorkError: workErrorSchema,
  WorkHttpError: workHttpErrorSchema,
  WorkUsage: workUsageSchema,
  WorkRun: workRunSchema,
  WorkAction: workActionSchema,
  WorkArtifact: workArtifactSchema,
  WorkEvent: workEventSchema,
  WorkSnapshot: workSnapshotWireSchema,
} as const;

type WorkOperation = {
  method: "get" | "post";
  path: string;
  operationId: string;
  status: number;
  request?: keyof typeof workHttpSchemas;
  response?: keyof typeof workHttpSchemas;
  maxBodyBytes?: number;
};
export const workHttpOperations: readonly WorkOperation[] = [
  {
    method: "post",
    path: "/api/v1/tasks",
    operationId: "createWorkTask",
    status: 202,
    request: "CreateTask",
    response: "WorkSnapshot",
    maxBodyBytes: 20000,
  },
  {
    method: "get",
    path: "/api/v1/tasks/{task_id}",
    operationId: "getWorkTask",
    status: 200,
    response: "WorkSnapshot",
  },
  {
    method: "get",
    path: "/api/v1/tasks/{task_id}/scope",
    operationId: "getNativeWorkTaskScope",
    status: 200,
    response: "NativeTaskScopeResponse",
  },
  {
    method: "post",
    path: "/api/v1/tasks/{task_id}/cancel",
    operationId: "cancelWorkTask",
    status: 200,
    request: "EmptyCommand",
    response: "WorkSnapshot",
    maxBodyBytes: 128,
  },
  {
    method: "post",
    path: "/api/v1/tasks/{task_id}/corrections",
    operationId: "correctWorkTask",
    status: 202,
    request: "RequestCorrection",
    response: "WorkCorrection",
    maxBodyBytes: 32768,
  },
  {
    method: "post",
    path: "/api/v1/actions/{action_id}/decision",
    operationId: "decideWorkAction",
    status: 200,
    request: "DecideAction",
    response: "WorkSnapshot",
    maxBodyBytes: 512,
  },
  {
    method: "post",
    path: "/api/v1/actions/{action_id}/reconcile",
    operationId: "requestWorkReconciliation",
    status: 202,
    request: "RequestReconciliation",
    response: "WorkReconciliation",
    maxBodyBytes: 4096,
  },
  {
    method: "get",
    path: "/api/v1/artifacts/{artifact_id}",
    operationId: "downloadWorkArtifact",
    status: 200,
  },
];

export function workHttpOpenApi() {
  return httpOpenApi(
    "OpenBot Work HTTP",
    workHttpSchemas,
    workHttpOperations.map((operation) => ({
      ...operation,
      errors: [401, 403, 404, 408, 409, 413, 422, 503],
    })),
    "WorkHttpError",
  );
}
