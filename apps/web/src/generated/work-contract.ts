// Generated from @openbot/protocol Work HTTP contracts. Run npm run contracts:generate.
import type { WorkJsonValue } from "@openbot/protocol";
export interface paths {
  "/api/v1/actions/{action_id}/decision": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["decideWorkAction"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/actions/{action_id}/reconcile": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["requestWorkReconciliation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/artifacts/{artifact_id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["downloadWorkArtifact"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/tasks": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["createWorkTask"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/tasks/{task_id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getWorkTask"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/tasks/{task_id}/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["cancelWorkTask"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/tasks/{task_id}/corrections": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["correctWorkTask"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/tasks/{task_id}/scope": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getNativeWorkTaskScope"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    __shared: {
      $defs: {
        schema0: WorkJsonValue;
      };
    };
    CreateTask: {
      botId: string;
      objective: string;
      requestKey: string;
      scope?: components["schemas"]["NativeTaskScope"] | null;
      tokenLimit: number;
    };
    DecideAction: {
      approved: boolean;
      intentDigest: string;
    };
    EmptyCommand: Record<string, never>;
    NativeTaskScope: {
      attachmentIds: string[];
      collaboratorBotIds: string[];
      knowledge: boolean;
      plugins: boolean;
      /** @constant */
      version: 1;
      web: boolean;
    };
    NativeTaskScopeResponse: {
      scope: {
        attachmentIds: string[];
        attachments: {
          /** Format: uuid */
          id: string;
          /** @enum {string} */
          mediaType:
            | "text/plain"
            | "image/png"
            | "image/jpeg"
            | "application/pdf"
            | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            | "application/vnd.oasis.opendocument.text"
            | "application/vnd.oasis.opendocument.spreadsheet"
            | "application/vnd.oasis.opendocument.presentation"
            | "audio/mpeg"
            | "audio/wav"
            | "audio/mp4"
            | "audio/webm"
            | "video/mp4"
            | "video/webm";
          metadataSha256: string;
          name: string;
          sha256: string;
          sizeBytes: number;
        }[];
        collaboratorBotIds: string[];
        knowledge: boolean;
        plugins: boolean;
        sha256: string;
        /** @constant */
        version: 1;
        web: boolean;
      } | null;
    };
    RequestCorrection: {
      expectedSequence: number;
      instruction: string;
      requestKey: string;
      runId: string;
    };
    RequestReconciliation: {
      expectedSequence: number;
      intentDigest: string;
      reason: string;
      requestKey: string;
    };
    WorkAction: {
      actualTokens: number | null;
      /** @enum {string} */
      decision: "not_required" | "pending" | "approved" | "denied";
      evidence: {
        [key: string]: string;
      } | null;
      expiresAt: string;
      id: string;
      intent: {
        [key: string]: components["schemas"]["__shared"]["$defs"]["schema0"];
      };
      intentDigest: string;
      /** @default null */
      reconciliation?: components["schemas"]["WorkReconciliation"] | null;
      reservedTokens: number;
      runId: string;
      /** @enum {string} */
      status: "proposed" | "admitted" | "unknown" | "applied" | "not_applied" | "superseded";
    };
    WorkArtifact: {
      downloadUrl: string;
      id: string;
      mediaType: string;
      name: string;
      runId: string;
      sha256: string;
      sizeBytes: number;
    };
    WorkCorrection: {
      createdAt: string;
      generation: number;
      id: string;
      instruction: string;
      /** @constant */
      requestedBy: "owner";
      runId: string;
      sequence: number;
      taskId: string;
    };
    WorkError: {
      detail:
        | string
        | {
            [key: string]: components["schemas"]["__shared"]["$defs"]["schema0"];
          }[];
    };
    WorkEvent: {
      kind: string;
      payload: {
        [key: string]: components["schemas"]["__shared"]["$defs"]["schema0"];
      };
      revision: number;
    };
    WorkHttpError: {
      error: string;
    };
    WorkReconciliation: {
      actionId: string;
      createdAt: string;
      delivered: boolean;
      id: string;
      outcome: ("resolved" | "unresolved") | null;
      reason: string;
      /** @constant */
      requestedBy: "owner";
      sequence: number;
    };
    WorkRun: {
      id: string;
      ordinal: number;
      /** @enum {string} */
      status: "queued" | "running" | "completed" | "cancelled" | "failed";
    };
    WorkSnapshot: {
      actions: components["schemas"]["WorkAction"][];
      artifacts: components["schemas"]["WorkArtifact"][];
      attention: ("approval" | "reconciliation" | "budget") | null;
      authorityActive: boolean;
      botId: string;
      cancelRequested: boolean;
      events: components["schemas"]["WorkEvent"][];
      eventsTruncated: boolean;
      id: string;
      objective: string;
      resultSummary: string | null;
      revision: number;
      runs: components["schemas"]["WorkRun"][];
      /** @enum {string} */
      status: "queued" | "open" | "completed" | "cancelled" | "failed";
      usage: components["schemas"]["WorkUsage"];
    };
    WorkUsage: {
      reservedTokens: number;
      spentTokens: number;
      tokenLimit: number;
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  decideWorkAction: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        action_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["DecideAction"];
      };
    };
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkSnapshot"];
        };
      };
      /** @description Product error */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      408: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
    };
  };
  requestWorkReconciliation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        action_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RequestReconciliation"];
      };
    };
    responses: {
      /** @description Successful response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkReconciliation"];
        };
      };
      /** @description Product error */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      408: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
    };
  };
  downloadWorkArtifact: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        artifact_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/octet-stream": string;
        };
      };
      /** @description Product error */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      408: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
    };
  };
  createWorkTask: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateTask"];
      };
    };
    responses: {
      /** @description Successful response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkSnapshot"];
        };
      };
      /** @description Product error */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      408: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
    };
  };
  getWorkTask: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        task_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkSnapshot"];
        };
      };
      /** @description Product error */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      408: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
    };
  };
  cancelWorkTask: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        task_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["EmptyCommand"];
      };
    };
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkSnapshot"];
        };
      };
      /** @description Product error */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      408: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
    };
  };
  correctWorkTask: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        task_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RequestCorrection"];
      };
    };
    responses: {
      /** @description Successful response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkCorrection"];
        };
      };
      /** @description Product error */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      408: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
    };
  };
  getNativeWorkTaskScope: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        task_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["NativeTaskScopeResponse"];
        };
      };
      /** @description Product error */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      408: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
      /** @description Product error */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkHttpError"];
        };
      };
    };
  };
}
