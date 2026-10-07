import { expect, it } from "vitest";
import { controlHttpOpenApi } from "./control-openapi.js";
import { nodeIdentitySummarySchema } from "./node-http.js";

it("keeps bootstrap exchange separate from Owner and Origin authorization", () => {
  const { paths } = controlHttpOpenApi();
  expect(paths["/api/v1/nodes/enroll"]?.post).toMatchObject({
    "x-openbot-owner-session": false,
    "x-openbot-allowed-origin": false,
    "x-openbot-max-body-bytes": 8192,
    responses: { "429": expect.any(Object) },
  });
  expect(paths["/api/v1/nodes/enrollment-tokens"]?.post).toMatchObject({
    "x-openbot-owner-session": true,
    "x-openbot-allowed-origin": true,
  });
});
it("refuses private digests and explicit optional nulls in public identity metadata", () => {
  const value = {
    nodeId: "fixture-host",
    status: "active",
    connected: false,
    enrolledAt: "2026-10-06T00:00:00.000Z",
  };
  expect(nodeIdentitySummarySchema.safeParse(value).success).toBe(true);
  for (const extra of [
    { credential: "private" },
    { credentialDigest: "private" },
    { clientIdentityDigest: "private" },
    { lastAuthenticatedAt: null },
    { revokedAt: null },
    { node: null },
    { connected: 1 },
  ])
    expect(nodeIdentitySummarySchema.safeParse({ ...value, ...extra }).success).toBe(false);
});
