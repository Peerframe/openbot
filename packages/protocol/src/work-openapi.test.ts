import { expect, it } from "vitest";
import { controlHttpOpenApi } from "./control-openapi.js";
import { workHttpOpenApi, workHttpOperations } from "./work-openapi.js";

it.each([workHttpOpenApi, controlHttpOpenApi])(
  "resolves every embedded OpenAPI reference: %s",
  (build) => {
    const document = build();
    let references = 0;
    function visit(value: unknown): void {
      if (!value || typeof value !== "object") return;
      if ("$ref" in value) {
        const reference = value.$ref;
        expect(typeof reference).toBe("string");
        expect(String(reference)).toMatch(/^#\/components\/schemas\//);
        let target: unknown = document;
        for (const part of String(reference).slice(2).split("/")) {
          expect(target && typeof target === "object").toBeTruthy();
          target = Reflect.get(target as object, part.replace(/~1/g, "/").replace(/~0/g, "~"));
        }
        expect(target).toBeDefined();
        references++;
      }
      for (const child of Object.values(value)) visit(child);
    }
    visit(document);
    expect(references).toBeGreaterThan(workHttpOperations.length);
  },
);

it("publishes code-point bounds and the complete correction/decision/reconciliation routes", () => {
  const document = workHttpOpenApi();
  const schemas = document.components.schemas as Record<
    string,
    { properties: Record<string, unknown> }
  >;
  expect(schemas.CreateTask?.properties.objective).toEqual({
    type: "string",
    minLength: 1,
    maxLength: 16384,
  });
  for (const operation of workHttpOperations) {
    expect(document.paths[operation.path]?.[operation.method]).toMatchObject({
      operationId: operation.operationId,
    });
  }
});

it("publishes raw upload headers, optional empty commands and model dependency conflicts", () => {
  expect(workHttpOpenApi().paths["/api/v1/artifacts/{artifact_id}"]?.get).toMatchObject({
    responses: {
      "200": {
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      },
      "503": {
        content: { "application/json": { schema: { $ref: "#/components/schemas/WorkHttpError" } } },
      },
    },
  });
  const { paths } = controlHttpOpenApi();
  expect(paths["/api/v1/artifacts/{artifact_id}/content"]?.get).toMatchObject({
    responses: {
      "200": {
        content: {
          "image/png": { schema: { type: "string", format: "binary" } },
          "text/markdown": { schema: { type: "string" } },
        },
      },
    },
  });
  const upload = paths["/api/v1/task-attachments"]?.post;
  expect(upload).toMatchObject({
    requestBody: {
      required: true,
      content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
    },
    "x-openbot-max-body-bytes": 10 * 1024 * 1024,
    parameters: expect.arrayContaining([
      expect.objectContaining({ name: "x-openbot-filename", in: "header", required: true }),
    ]),
  });
  expect(paths["/api/v1/task-attachments/{attachment_id}/restore"]?.post).toMatchObject({
    requestBody: { required: false },
    "x-openbot-max-body-bytes": 32768,
  });
  expect(paths["/api/v1/model-connections/{connection_id}/models"]?.post).toMatchObject({
    "x-openbot-max-body-bytes": 1024,
  });
  expect(paths["/api/v1/model-connections/{connection_id}"]?.delete).toMatchObject({
    responses: {
      "409": {
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ModelConnectionDeletionError",
            },
          },
        },
      },
    },
  });
});

it("binds portable downloads to required instance/review inputs and advertises both document media", () => {
  const { paths } = controlHttpOpenApi();
  const download = paths["/api/v1/bots/{bot_id}/export"]?.get;
  expect(download).toMatchObject({
    parameters: expect.arrayContaining([
      expect.objectContaining({ name: "packageId", in: "query", required: true }),
      expect.objectContaining({ name: "generatedAt", in: "query", required: true }),
      expect.objectContaining({
        name: "includeSkillContent",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["true"] },
      }),
      expect.objectContaining({ name: "if-match", in: "header", required: true }),
    ]),
    responses: {
      "200": {
        content: {
          "application/vnd.openbot.employee+json": {
            schema: { $ref: "#/components/schemas/EmployeeDocument" },
          },
          "application/vnd.openbot.employee.dsse+json": {
            schema: { $ref: "#/components/schemas/EmployeeDocument" },
          },
        },
      },
      "412": expect.anything(),
      "428": expect.anything(),
    },
  });
  expect(paths["/api/v1/employees/import/preview"]?.post).toMatchObject({
    requestBody: {
      required: true,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/EmployeeDocument" } },
      },
    },
    "x-openbot-max-body-bytes": 2 * 1024 * 1024,
  });
  const preview = paths["/api/v1/employees/import/preview"]?.post as {
    requestBody: { content: Record<string, unknown> };
  };
  expect(Object.keys(preview.requestBody.content)).toEqual(["application/json"]);
  expect(paths["/api/v1/employees/import/activate"]?.post).toMatchObject({
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/EmployeeImportActivationResponse" },
          },
        },
      },
      "201": {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/EmployeeImportActivationResponse" },
          },
        },
      },
    },
    "x-openbot-max-body-bytes": 2 * 1024 * 1024 + 65536,
  });
});

it("preserves named browser operation IDs, unparsed opening body and command admission", () => {
  const { paths } = controlHttpOpenApi();
  const opening = paths["/api/v1/bots/{bot_id}/browser"]?.post;
  expect(opening).toMatchObject({
    operationId: "openEmployeeBrowser",
    responses: { "201": expect.anything() },
  });
  expect(opening).not.toHaveProperty("requestBody");
  expect(paths["/api/v1/browser-sessions/{session_id}/commands"]?.post).toMatchObject({
    operationId: "commandEmployeeBrowser",
    "x-openbot-max-body-bytes": 20000,
    requestBody: { required: true },
  });
  expect(paths["/api/v1/bots/{bot_id}/browser/maintenance"]?.post).toMatchObject({
    operationId: "maintainEmployeeBrowser",
    "x-openbot-max-body-bytes": 1024,
  });
  expect(paths["/api/v1/browser-sessions/{session_id}"]?.delete).toMatchObject({
    operationId: "closeEmployeeBrowser",
    responses: { "204": { description: "Successful response" } },
  });
});
