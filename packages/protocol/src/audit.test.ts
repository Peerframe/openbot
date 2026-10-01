import { expect, it } from "vitest";
import { auditEventSchema, auditExportQuerySchema, auditQuerySchema } from "./audit.js";

it("bounds categories, pagination and export independently", () => {
  expect(auditQuerySchema.safeParse({ category: "hosts", limit: 100 }).success).toBe(true);
  expect(auditQuerySchema.safeParse({ category: "unknown" }).success).toBe(false);
  expect(auditQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  expect(auditExportQuerySchema.safeParse({ limit: 1000 }).success).toBe(true);
  expect(auditExportQuerySchema.safeParse({ limit: 1001 }).success).toBe(false);
});
it("never accepts raw payloads or credentials as event fields", () => {
  const event = {
    id: "event",
    type: "AUTH_LOGIN_SUCCEEDED",
    category: "authentication",
    createdAt: "2026-10-01T00:00:00.000Z",
    details: { actor: "owner" },
  };
  expect(auditEventSchema.safeParse(event).success).toBe(true);
  expect(auditEventSchema.safeParse({ ...event, payload: { apiKey: "private" } }).success).toBe(
    false,
  );
});
