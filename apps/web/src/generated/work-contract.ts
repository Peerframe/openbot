// Generated from Python Work HTTP responses. Run npm run contracts:generate.
export interface paths {
  "/api/v1/tasks/{task_id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Read */
    get: operations["getWorkTask"];
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
    /** HTTPValidationError */
    HTTPValidationError: {
      /** Detail */
      detail?: components["schemas"]["ValidationError"][];
    };
    JsonValue: unknown;
    /** ValidationError */
    ValidationError: {
      /** Context */
      ctx?: Record<string, never>;
      /** Input */
      input?: unknown;
      /** Location */
      loc: (string | number)[];
      /** Message */
      msg: string;
      /** Error Type */
      type: string;
    };
    /** WorkAction */
    WorkAction: {
      /** Actualtokens */
      actualTokens: number | null;
      /**
       * Decision
       * @enum {string}
       */
      decision: "not_required" | "pending" | "approved" | "denied";
      /** Evidence */
      evidence: {
        [key: string]: string;
      } | null;
      /** Expiresat */
      expiresAt: string;
      /** Id */
      id: string;
      /** Intent */
      intent: {
        [key: string]: components["schemas"]["JsonValue"];
      };
      /** Intentdigest */
      intentDigest: string;
      reconciliation?: components["schemas"]["WorkReconciliation"] | null;
      /** Reservedtokens */
      reservedTokens: number;
      /** Runid */
      runId: string;
      /**
       * Status
       * @enum {string}
       */
      status: "proposed" | "admitted" | "unknown" | "applied" | "not_applied" | "superseded";
    };
    /** WorkArtifact */
    WorkArtifact: {
      /** Downloadurl */
      downloadUrl: string;
      /** Id */
      id: string;
      /** Mediatype */
      mediaType: string;
      /** Name */
      name: string;
      /** Runid */
      runId: string;
      /** Sha256 */
      sha256: string;
      /** Sizebytes */
      sizeBytes: number;
    };
    /** WorkCorrection */
    WorkCorrection: {
      /** Createdat */
      createdAt: string;
      /** Generation */
      generation: number;
      /** Id */
      id: string;
      /** Instruction */
      instruction: string;
      /**
       * Requestedby
       * @constant
       */
      requestedBy: "owner";
      /** Runid */
      runId: string;
      /** Sequence */
      sequence: number;
      /** Taskid */
      taskId: string;
    };
    /** WorkEvent */
    WorkEvent: {
      /** Kind */
      kind: string;
      /** Payload */
      payload: {
        [key: string]: components["schemas"]["JsonValue"];
      };
      /** Revision */
      revision: number;
    };
    /** WorkReconciliation */
    WorkReconciliation: {
      /** Actionid */
      actionId: string;
      /** Createdat */
      createdAt: string;
      /** Delivered */
      delivered: boolean;
      /** Id */
      id: string;
      /** Outcome */
      outcome: ("resolved" | "unresolved") | null;
      /** Reason */
      reason: string;
      /**
       * Requestedby
       * @constant
       */
      requestedBy: "owner";
      /** Sequence */
      sequence: number;
    };
    /** WorkRun */
    WorkRun: {
      /** Id */
      id: string;
      /** Ordinal */
      ordinal: number;
      /**
       * Status
       * @enum {string}
       */
      status: "queued" | "running" | "completed" | "cancelled" | "failed";
    };
    /** WorkSnapshot */
    WorkSnapshot: {
      /** Actions */
      actions: components["schemas"]["WorkAction"][];
      /** Artifacts */
      artifacts: components["schemas"]["WorkArtifact"][];
      /** Attention */
      attention: ("approval" | "reconciliation" | "budget") | null;
      /** Authorityactive */
      authorityActive: boolean;
      /** Botid */
      botId: string;
      /** Cancelrequested */
      cancelRequested: boolean;
      /** Events */
      events: components["schemas"]["WorkEvent"][];
      /** Eventstruncated */
      eventsTruncated: boolean;
      /** Id */
      id: string;
      /** Objective */
      objective: string;
      /** Resultsummary */
      resultSummary: string | null;
      /** Revision */
      revision: number;
      /** Runs */
      runs: components["schemas"]["WorkRun"][];
      /**
       * Status
       * @enum {string}
       */
      status: "queued" | "open" | "completed" | "cancelled" | "failed";
      usage: components["schemas"]["WorkUsage"];
    };
    /** WorkUsage */
    WorkUsage: {
      /** Reservedtokens */
      reservedTokens: number;
      /** Spenttokens */
      spentTokens: number;
      /** Tokenlimit */
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
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkSnapshot"];
        };
      };
      /** @description Validation Error */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["HTTPValidationError"];
        };
      };
    };
  };
}
