import { z } from "zod";

export type HttpOperation = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  status: number;
  additionalSuccessStatuses?: readonly number[];
  request?: string;
  requestRequired?: boolean;
  response?: string;
  maxBodyBytes?: number;
  requestMediaType?: "application/octet-stream";
  owner?: boolean;
  origin?: boolean;
  mediaType?: "application/octet-stream" | "text/event-stream" | "text/csv";
  responseMediaTypes?: readonly (
    | "text/markdown"
    | "image/png"
    | "application/vnd.openbot.employee+json"
    | "application/vnd.openbot.employee.dsse+json"
  )[];
  query?: readonly { name: string; required?: boolean; schema: Record<string, unknown> }[];
  headers?: readonly { name: string; required: boolean; schema: Record<string, unknown> }[];
  errors?: readonly number[];
  errorSchemas?: Readonly<Record<number, string>>;
};

/** Retain FastAPI's generated IDs for product extension registrations; this grants no authority. */
export function productHttpOperation(
  path: string,
  method: HttpOperation["method"],
  response?: string,
  request?: string,
  options: Partial<HttpOperation> = {},
): HttpOperation {
  return {
    path,
    method,
    operationId: `endpoint${path.replace(/[^a-zA-Z0-9_]/g, "_")}_${method}`,
    status: 200,
    ...(response ? { response } : {}),
    ...(request ? { request } : {}),
    ...options,
  };
}

/** Embed Zod's standalone resources as local OpenAPI references, preserving recursive JSON. */
export function httpOpenApi(
  title: string,
  contracts: Record<string, z.ZodType>,
  operations: readonly HttpOperation[],
  errorSchema: string,
) {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(contracts)) registry.add(schema, { id });
  const standalone = z.toJSONSchema(registry, {
    io: "input",
    target: "draft-2020-12",
    uri: (id) => `urn:openbot:http:${id}`,
  }).schemas;
  function embedded(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(embedded);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "$id")
          .map(([key, item]) => [
            key,
            key === "$ref" && typeof item === "string"
              ? item.replace(/^urn:openbot:http:([^#]+)(?:#(.*))?$/, "#/components/schemas/$1$2")
              : embedded(item),
          ]),
      );
    }
    return value;
  }
  const jsonContent = (id: string, mediaTypes: readonly string[] = ["application/json"]) => {
    if (!(id in contracts)) throw new Error(`Unknown HTTP schema: ${id}`);
    return Object.fromEntries(
      mediaTypes.map((mediaType) => [
        mediaType,
        { schema: { $ref: `#/components/schemas/${id}` } },
      ]),
    );
  };
  const paths: Record<string, Record<string, unknown>> = {};
  const ids = new Set<string>();
  for (const operation of operations) {
    if (ids.has(operation.operationId) || paths[operation.path]?.[operation.method])
      throw new Error(`Duplicate HTTP operation: ${operation.operationId}`);
    ids.add(operation.operationId);
    const parameters = [
      ...[...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
        name: match[1],
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 128 },
      })),
      ...(operation.query ?? []).map((item) => ({
        ...item,
        in: "query",
        required: item.required ?? false,
      })),
      ...(operation.headers ?? []).map((item) => ({ ...item, in: "header" })),
    ];
    const errors = Object.fromEntries(
      (operation.errors ?? [401, 403, 404, 408, 409, 413, 422, 503]).map((status) => [
        status,
        {
          description: "Product error",
          content: jsonContent(operation.errorSchemas?.[status] ?? errorSchema),
        },
      ]),
    );
    paths[operation.path] ??= {};
    const methods = paths[operation.path];
    if (!methods) throw new Error("Missing operation map.");
    methods[operation.method] = {
      operationId: operation.operationId,
      "x-openbot-owner-session": operation.owner ?? true,
      "x-openbot-allowed-origin": operation.origin ?? operation.method !== "get",
      ...(parameters.length ? { parameters } : {}),
      ...(operation.request || operation.requestMediaType
        ? {
            requestBody: {
              required: operation.requestRequired ?? true,
              content: operation.request
                ? jsonContent(operation.request)
                : { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
            },
          }
        : {}),
      ...(operation.maxBodyBytes === undefined
        ? {}
        : { "x-openbot-max-body-bytes": operation.maxBodyBytes }),
      responses: {
        ...errors,
        ...Object.fromEntries(
          [operation.status, ...(operation.additionalSuccessStatuses ?? [])].map((status) => [
            status,
            {
              description: "Successful response",
              ...(status === 204
                ? {}
                : {
                    content: operation.response
                      ? jsonContent(operation.response, operation.responseMediaTypes)
                      : Object.fromEntries(
                          (
                            operation.responseMediaTypes ?? [
                              operation.mediaType ?? "application/octet-stream",
                            ]
                          ).map((mediaType) => [
                            mediaType,
                            {
                              schema: {
                                type: "string",
                                ...(mediaType === "image/png" ||
                                mediaType === "application/octet-stream"
                                  ? { format: "binary" }
                                  : {}),
                              },
                            },
                          ]),
                        ),
                  }),
            },
          ]),
        ),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title, version: "1" },
    paths,
    components: { schemas: embedded(standalone) },
  };
}
