import { describe, expect, it } from "vitest";
import {
  addReportedUsage,
  nativeFailureMessages,
  runModelUsageSchema,
} from "./agent-observations.js";
import type { LanguageModelUsage } from "ai";
const identity = { provider: "openai" as const, model: "fixture" };
const step = (inputTokens: number | undefined, outputTokens: number | undefined) =>
  ({ inputTokens, outputTokens }) as LanguageModelUsage;
describe("provider-reported usage", () => {
  it("retains known zero, sums steps and keeps missing counts unknown", () => {
    const first = addReportedUsage(undefined, step(0, 5), identity);
    expect(first).toEqual({ ...identity, steps: 1, inputTokens: 0, outputTokens: 5 });
    const second = addReportedUsage(first, step(undefined, 7), identity);
    const third = addReportedUsage(second, step(10, 3), identity);
    expect(third).toEqual({ ...identity, steps: 3, inputTokens: null, outputTokens: 15 });
  });
  it.each([-1, NaN, Infinity, 1.5, 1_000_000_001])(
    "does not turn invalid reported count %s into usage",
    (value) => {
      expect(addReportedUsage(undefined, step(value, 0), identity).inputTokens).toBeNull();
    },
  );
  it("rejects raw fields, excessive steps and provider strings", () => {
    const usage = { ...identity, steps: 1, inputTokens: 1, outputTokens: 2 };
    expect(runModelUsageSchema.safeParse({ ...usage, raw: { secret: "not stored" } }).success).toBe(
      false,
    );
    expect(runModelUsageSchema.safeParse({ ...usage, steps: 9 }).success).toBe(false);
    expect(runModelUsageSchema.safeParse({ ...usage, provider: "private-host" }).success).toBe(
      false,
    );
  });
});

describe("native failure catalogue", () => {
  it("keeps permission loss separate from invalid targets and resource drift", () => {
    expect(nativeFailureMessages.scope_revoked).toMatch(/channel/i);
    expect(nativeFailureMessages.invalid_target).toMatch(/target/i);
    expect(nativeFailureMessages.invalid_target).not.toMatch(/channel/i);
    expect(nativeFailureMessages.conflict).toMatch(/state changed/i);
    expect(nativeFailureMessages.skills_changed).toMatch(/skills changed/i);
    expect(nativeFailureMessages.memory_changed).toMatch(/memory changed/i);
  });
});
