import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyResponses,
  KNOWN_GAPS,
  parseAcceptanceArgs,
  redact,
} from "./ui-acceptance-report.ts";

test("arguments default to the Python entry and reject unknown or incomplete values", () => {
  assert.deepEqual(parseAcceptanceArgs([]), {
    entry: "python",
    browser: undefined,
    out: undefined,
    headed: false,
  });
  assert.deepEqual(parseAcceptanceArgs(["--entry", "ts", "--browser", "/x/chrome", "--headed"]), {
    entry: "ts",
    browser: "/x/chrome",
    out: undefined,
    headed: true,
  });
  assert.throws(() => parseAcceptanceArgs(["--entry", "go"]), /python or ts/);
  assert.throws(() => parseAcceptanceArgs(["--browser"]), /needs a value/);
  assert.throws(() => parseAcceptanceArgs(["--browser", "--headed"]), /needs a value/);
  assert.throws(() => parseAcceptanceArgs(["--fast"]), /Unknown argument/);
});

test("only an exact known gap is allowed; every other error status fails", () => {
  const run = "2210e605-3250-4718-8a4a-88fa9d749282";
  const tally = classifyResponses([
    { method: "GET", path: "/api/v1/workspace", status: 200 },
    { method: "GET", path: `/api/v1/runs/${run}/output`, status: 404 },
    { method: "POST", path: `/api/v1/runs/${run}/output`, status: 404 },
    { method: "GET", path: `/api/v1/runs/${run}/output/extra`, status: 404 },
    { method: "GET", path: `/api/v1/runs/${run}/output`, status: 500 },
    { method: "GET", path: "/api/v1/plugins", status: 503 },
  ]);
  assert.deepEqual(tally.byStatus, { 200: 1, 404: 3, 500: 1, 503: 1 });
  assert.equal(tally.allowed.length, 1);
  assert.equal(tally.allowed[0]?.reason, KNOWN_GAPS[0]?.reason);
  assert.deepEqual(
    tally.unexpected.map((item) => `${item.method} ${item.status}`),
    ["POST 404", "GET 404", "GET 500", "GET 503"],
  );
});

test("generated secrets never reach the receipt", () => {
  const password = "239cd71d6c4956846b06ecef";
  assert.equal(
    redact(`login failed for ${password} at postgres://u:${password}@h/db`, [password, "short"]),
    "login failed for [redacted] at postgres://u:[redacted]@h/db",
  );
});
