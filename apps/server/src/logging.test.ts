/** Verifies HTTP and causal diagnostics cannot serialize untrusted credentials or message text. */
import { createLogger } from "@openbot/logging";
import { expect, it } from "vitest";
import { HttpFailure } from "./http-errors.js";
import {
  desktopStartupExitCode,
  failureFields,
  httpLogger,
  StartupFailure,
  startup,
} from "./logging.js";

it("retains bounded driver identifiers through a startup cause without messages or paths", () => {
  const cause = Object.assign(
    new Error(["postgres:", "//secret:password@private/database"].join("")),
    { code: "ECONNREFUSED" },
  );
  const startup = new Error("/private/credentials/startup", { cause });
  expect(failureFields(startup)).toEqual({ errorName: "Error", code: "ECONNREFUSED" });
  expect(failureFields(new HttpFailure(503, { error: "storage_unavailable" }, { cause }))).toEqual({
    errorName: "HttpFailure",
    status: 503,
    code: "storage_unavailable",
  });
  cause.code = "private-provider-token";
  expect(failureFields(cause)).toEqual({ errorName: "Error" });
});
it("adapts Fastify records with an allowlist and discards messages, headers, URLs, and arbitrary child fields", () => {
  let output = "";
  const logger = httpLogger(
    createLogger({
      level: "debug",
      destination: {
        write: (line) => {
          output += line;
        },
      },
    }),
  );
  const child = logger.child({ reqId: "req-1", authorization: "SECRET-BINDING" });
  child.info(
    {
      req: {
        method: "GET",
        url: "/private?token=SECRET-URL",
        headers: { cookie: "SECRET-COOKIE" },
      },
    },
    "SECRET-MESSAGE",
  );
  child.error(
    { err: new Error("SECRET-ERROR"), res: { statusCode: 503 }, responseTime: 12 },
    "SECRET-MESSAGE",
  );
  child.warn("SECRET-STRING");
  const records = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(3);
  expect(records[0]).toMatchObject({ method: "GET", requestId: "req-1" });
  expect(records[1]).toMatchObject({ status: 503, durationMs: 12, errorName: "Error" });
  expect(output).not.toContain("SECRET");
  expect(output).not.toContain("stack");
});

it("records the innermost fixed startup phase while preserving the original cause privately", async () => {
  const cause = new Error("SECRET-temporal-configuration");
  await expect(
    startup("work-engine", () => {
      throw cause;
    }),
  ).rejects.toMatchObject({ cause });
  const nested = new StartupFailure("product-schema", new StartupFailure("work-engine", cause));
  expect(failureFields(nested)).toEqual({ errorName: "StartupFailure", phase: "work-engine" });
});

it("reserves the Desktop dependency exit only for an actual Temporal connection phase", () => {
  const connect = new StartupFailure("temporal-connect", new Error("PRIVATE-network-details"));
  expect(desktopStartupExitCode(new StartupFailure("work-engine", connect))).toBe(75);
  for (const phase of ["configuration", "product-storage", "work-engine", "desktop-preflight"])
    expect(
      desktopStartupExitCode(new StartupFailure(phase, new Error("Temporal unavailable"))),
    ).toBe(1);
  expect(
    desktopStartupExitCode(Object.assign(new Error("temporal-connect"), { code: "ECONNREFUSED" })),
  ).toBe(1);
});
