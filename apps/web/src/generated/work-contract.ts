// Generated from Python Work HTTP requests, responses and errors. Run npm run contracts:generate.
export interface paths {
  "/api/v1/tasks": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Create */
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
  "/api/v1/tasks/{task_id}/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Cancel */
    post: operations["cancelWorkTask"];
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
    /** CreateTask */
    CreateTask: {
      /** Botid */
      botId: string;
      /** Objective */
      objective: string;
      /** Requestkey */
      requestKey: string;
      /** @default null */
      scope?: components["schemas"]["NativeTaskScope"] | null;
      /** Tokenlimit */
      tokenLimit: number;
    };
    /** DecideAction */
    DecideAction: {
      /** Approved */
      approved: boolean;
      /** Intentdigest */
      intentDigest: string;
    };
    /** EmptyCommand */
    EmptyCommand: Record<string, never>;
    /** HTTPValidationError */
    HTTPValidationError: {
      /** Detail */
      detail?: components["schemas"]["ValidationError"][];
    };
    JsonValue: unknown;
    /** NativeTaskScope */
    NativeTaskScope: {
      /** Attachmentids */
      attachmentIds: string[];
      /** Collaboratorbotids */
      collaboratorBotIds: string[];
      /** Knowledge */
      knowledge: boolean;
      /** Plugins */
      plugins: boolean;
      /** Version */
      version: number;
      /** Web */
      web: boolean;
    };
    /** RequestCorrection */
    RequestCorrection: {
      /** Expectedsequence */
      expectedSequence: number;
      /** Instruction */
      instruction: string;
      /** Requestkey */
      requestKey: string;
      /** Runid */
      runId: string;
    };
    /** RequestReconciliation */
    RequestReconciliation: {
      /** Expectedsequence */
      expectedSequence: number;
      /** Intentdigest */
      intentDigest: string;
      /** Reason */
      reason: string;
      /** Requestkey */
      requestKey: string;
    };
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
    /** WorkError */
    WorkError: {
      /** Detail */
      detail:
        | string
        | {
            [key: string]: components["schemas"]["JsonValue"];
          }[];
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
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkSnapshot"];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Request Timeout */
      408: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Request Entity Too Large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Unprocessable Entity */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
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
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkSnapshot"];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Unprocessable Entity */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
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
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkSnapshot"];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Request Timeout */
      408: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Request Entity Too Large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
      /** @description Unprocessable Entity */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkError"];
        };
      };
    };
  };
}
