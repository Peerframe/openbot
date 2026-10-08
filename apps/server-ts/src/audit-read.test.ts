import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
const python = fileURLToPath(
  new URL("../../server-python/.worker-venv/bin/python", import.meta.url),
);
it.skipIf(!existsSync(python))(
  "matches the retained Python datetime parser on aware audit cursors",
  () => {
    const dates = [
      "2026-10-08",
      "20261008",
      "2026-W41-4",
      "2026W414",
      "2026-W41",
      "2026-W53-1",
      "2024-02-29",
      "2025-02-29",
      "0001-01-01",
    ];
    const times = [
      "T05:42:10.123456Z",
      " 054210,1234567+0800",
      "💼05Z",
      "T05:42Z",
      "T05.3Z",
      "T05:42:10+01:99",
      "T05:42:10+00:00:00.5",
      "T05:42:10+08:12:13.111",
      "T24:00Z",
      "T05:42",
      "T05:99Z",
      "T05:42z",
    ];
    const values = dates.flatMap((date) => times.map((time) => date + time));
    const result = spawnSync(
      python,
      [
        "-I",
        "-B",
        "-c",
        `import json,sys
from datetime import datetime,timezone
out=[]
for value in json.load(sys.stdin):
 try:
  date=datetime.fromisoformat(value)
  if date.tzinfo is None: raise ValueError()
  out.append(date.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00','Z'))
 except (ValueError,OverflowError): out.append(None)
json.dump(out,sys.stdout)`,
      ],
      { input: JSON.stringify(values), encoding: "utf8", timeout: 5000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const expected = JSON.parse(result.stdout);
    for (const [index, value] of values.entries()) {
      let actual: string | null = null;
      try {
        actual = auditCursorTime(value);
      } catch {
        /* Both parsers refuse malformed timestamps. */
      }
      expect(actual, value).toBe(expected[index]);
    }
  },
);
