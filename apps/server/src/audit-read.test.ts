/** Retains cursor, CSV and sampled-progress contracts without a second runtime. */
import { legacy } from "../tests/legacy-fixtures.js";
import { expect, it } from "vitest";
import { auditCsv, auditCursorTime, auditQuery, csvCell } from "./audit-read.js";
import { selectedProgressSteps } from "./run-progress.js";

it("retains microseconds and normalizes calendar, basic and week-date aware cursors", () => {
  expect(auditCursorTime("2026-10-08T13:42:00.123456+08:00")).toBe("2026-10-08T05:42:00.123456Z");
  expect(auditCursorTime("20261008T054200,1234567Z")).toBe("2026-10-08T05:42:00.123456Z");
  expect(auditCursorTime("2026-W41-4T05:42Z")).toBe("2026-10-08T05:42:00.000000Z");
  expect(auditCursorTime("0001-01-01T00:00:00.000001Z")).toBe("0001-01-01T00:00:00.000001Z");
});
it("refuses duplicate/unknown parameters, invalid limits, categories and unbounded cursors", () => {
  expect(auditQuery(new URLSearchParams())).toMatchObject({ limit: 50 });
  expect(auditQuery(new URLSearchParams(), true)).toMatchObject({ limit: 1000 });
  for (const query of [
    "extra=1",
    "limit=0",
    "limit=101",
    "limit=1&limit=2",
    "limit= 1",
    "category=unknown",
    "before=bad",
    "before=",
    "before=2026-02-30T00:00:00Z|e",
    "before=2026-10-08T00:00:00|e",
    "before=2026-10-08T00:00:00Z|" + "a".repeat(129),
  ]) {
    expect(() => auditQuery(new URLSearchParams(query))).toThrow();
  }
});
it("quotes CSV cells, guards all retained formula prefixes and preserves Unicode/newlines", () => {
  for (const source of [
    "=1+1",
    "+cmd",
    "-2+3",
    "@SUM(A1)",
    "\t=1",
    " \r\n@cmd",
    "\ufeff=1",
    "＝1+1",
    "\0-42",
  ])
    expect(csvCell(source)).toBe("'" + source);
  const value = auditCsv([
    {
      id: "event",
      type: "CHANNEL_RENAMED",
      category: "channels",
      createdAt: "2026-10-08T00:00:00.000Z",
      channelName: 'A, "B"\n中',
      details: { name: "=not evaluated" },
    },
  ]);
  expect(value.subarray(0, 3)).toEqual(Buffer.from([239, 187, 191]));
  expect(value.toString()).toContain('"A, ""B""\n中"');
  expect(value.toString().endsWith("\r\n")).toBe(true);
});
it("validates selected step ordinals before the relation numbers and samples checkpoints", () => {
  expect(selectedProgressSteps(new URLSearchParams())).toBeNull();
  expect(selectedProgressSteps(new URLSearchParams("steps=12,1,9999999"))).toEqual([
    1, 12, 9999999,
  ]);
  for (const value of [
    "steps=0",
    "steps=1,1",
    "steps=01",
    "steps=1&steps=2",
    "steps=",
    "other=1",
    "steps=10000000",
    "steps=" + Array.from({ length: 13 }, (_, i) => i + 1).join(","),
  ])
    expect(() => selectedProgressSteps(new URLSearchParams(value))).toThrow();
});
it("matches the frozen legacy datetime vectors, including refused aware cursors", () => {
  for (const { input, expected } of legacy.audit) {
    let actual: string | null = null;
    try { actual = auditCursorTime(input); } catch { /* Refused legacy timestamps remain refused. */ }
    expect(actual, input).toBe(expected);
  }
});
