import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkFiles } from "./work-files.js";
import type { WorkAction } from "./work-ledger.js";
import { workBrowserOrigin, workBrowserRoutesSchema } from "./work-browser-profiles.js";
import {
  browserAllowed,
  browserArguments,
  browserIntent,
  browserObservation,
  browserOperation,
  browserPayload,
} from "./work-browser-tools.js";
import { workCanonical } from "./work-values.js";

it("retains canonical deployment origins and rejects normalization, credentials and remote plaintext", () => {
  expect(workBrowserOrigin("https://example.test/path?q=1#fragment")).toBe("https://example.test");
  expect(workBrowserOrigin("http://127.0.0.1:8123/path")).toBe("http://127.0.0.1:8123");
  const credential = new URL("https://example.test");
  credential.username = "fixture";
  for (const url of [
    credential.href,
    "https://Example.test",
    "https://example.test:443",
    "http://example.test",
    "https://127.1",
    "https://example.test\\@evil.test",
    "https://example.test/\npath",
    "https://example.test/中文",
    "https://example.test:0",
  ])
    expect(() => workBrowserOrigin(url)).toThrow();
  expect(() => browserAllowed("about:blank", ["https://example.test"], true)).not.toThrow();
  expect(() => browserAllowed("about:blank", ["https://example.test"])).toThrow();
  expect(() =>
    browserAllowed("https://example.test.evil.invalid", ["https://example.test"]),
  ).toThrow();
  const bot = randomUUID();
  expect(
    workBrowserRoutesSchema.safeParse({
      browserRoutes: { [bot]: "fixture" },
      pageOrigins: { [randomUUID()]: ["https://example.test"] },
    }).success,
  ).toBe(false);
  expect(
    workBrowserRoutesSchema.safeParse({
      browserRoutes: { [bot]: "fixture" },
      pageOrigins: { [bot]: ["https://example.test", "https://example.test"] },
    }).success,
  ).toBe(false);
});
it("input operations bind a prior observation; model input cannot supply an expected page or authority", () => {
  const args = { observationId: randomUUID(), ref: "e1", text: "" };
  expect(browserArguments.type_browser.parse(args).text).toBe("");
  expect(() => browserArguments.type_browser.parse({ ...args, expected: {} })).toThrow();
  expect(() =>
    browserArguments.press_browser_key.parse({ observationId: args.observationId, key: "F12" }),
  ).toThrow();
  expect(() =>
    browserArguments.scroll_browser.parse({ observationId: args.observationId, deltaY: 2001 }),
  ).toThrow();
  expect(() => browserOperation("type_browser", args)).toThrow();
  const operation = browserOperation("type_browser", args, {
    url: "https://example.test",
    snapshotId: 1,
    frameSha256: "a".repeat(64),
  });
  const intent = {
    kind: "deferred_tool",
    tool: "type_browser",
    arguments: args,
    effect: {
      kind: "work_browser_page",
      version: 1,
      profileSha256: "a".repeat(64),
      scopeSha256: "b".repeat(64),
      connectionId: randomUUID(),
      controlRevision: null,
      observationId: args.observationId,
      operation,
    },
  };
  expect(browserIntent(intent).effect.kind).toBe("work_browser_page");
  expect(() => browserIntent({ ...intent, arguments: { ...args, text: "unapproved" } })).toThrow();
  expect(() =>
    browserIntent({ ...intent, effect: { ...intent.effect, observationId: randomUUID() } }),
  ).toThrow();
});
it("browser receipts require the original approval and exact private bytes, not a fabricated output descriptor", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "openbot-browser-receipt-")));
  try {
    const files = new WorkFiles(directory),
      png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(3, 20);
    const image = { ...files.put(png), width: 2, height: 3, capturedAt: new Date().toISOString() },
      id = randomUUID();
    const intent = {
      kind: "deferred_tool",
      tool: "capture_browser",
      arguments: {},
      effect: {
        kind: "work_browser_capture",
        version: 1,
        profileSha256: "a".repeat(64),
        connectionId: randomUUID(),
        controlRevision: null,
      },
    };
    const action = {
      id,
      intent,
      intent_digest: workCanonical(intent).digest,
      requires_approval: true,
      decision: "approved",
    } as WorkAction;
    const value = {
      schema: "openbot.work-browser-capture/v1",
      image,
      payload: browserPayload(id, image),
    };
    const json = JSON.parse(JSON.stringify(value));
    expect(browserObservation(files, action, json).image.sha256).toBe(image.sha256);
    expect(() => browserObservation(files, { ...action, decision: "pending" }, json)).toThrow();
    expect(() =>
      browserObservation(files, action, {
        ...json,
        payload: { ...json.payload, visualContentProvided: true },
      }),
    ).toThrow();
    const bad = { ...image, width: 1 };
    expect(() =>
      browserObservation(
        files,
        action,
        JSON.parse(
          JSON.stringify({ schema: value.schema, image: bad, payload: browserPayload(id, bad) }),
        ),
      ),
    ).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
