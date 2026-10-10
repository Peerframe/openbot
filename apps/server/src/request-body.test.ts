/** Exercises body deadlines, interrupted uploads, bounded discards, and listener cleanup. */
import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { HttpFailure } from "./http-errors.js";
import { requestBody } from "./request-body.js";
import { attachmentUpload } from "./attachment-upload.js";
const options = { maximum: 8, timeoutMs: 100, tooLarge: new HttpFailure(413, { error: "body_limit" }) };
afterEach(() => vi.useRealTimers());
it("returns byte-exact accepted data and refuses malformed filename before reading", async () => {
  const bytes = Buffer.from([0, 255, 1]);
  expect(await requestBody(Readable.from([bytes]), new AbortController().signal, options)).toEqual(bytes);
  const body = new PassThrough();
  await expect(attachmentUpload(body, { "content-type": "application/octet-stream", "x-openbot-filename": "%GG" }, new AbortController().signal))
    .rejects.toMatchObject({ status: 400, body: { error: "invalid_attachment_name" } });
  expect(body.listenerCount("data")).toBe(0);
  body.destroy();
});
it("classifies timed-out and disconnected input without reporting a storage outage", async () => {
  vi.useFakeTimers();
  const timed = new PassThrough();
  const pending = expect(requestBody(timed, new AbortController().signal, options))
    .rejects.toMatchObject({ status: 408, body: { error: "request_timeout" } });
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  expect(timed.listenerCount("data")).toBe(0);
  timed.destroy();
  const disconnected = new PassThrough();
  const rejected = expect(requestBody(disconnected, new AbortController().signal, options))
    .rejects.toMatchObject({ status: 400, body: { error: "invalid_request_body" } });
  disconnected.destroy();
  await rejected;
  expect(disconnected.listenerCount("data")).toBe(0);
});
it("stops retaining bytes beyond the limit and bounds how much rejected data it drains", async () => {
  const body = new PassThrough();
  const pending = expect(requestBody(body, new AbortController().signal, { ...options, discardBytes: 4 }))
    .rejects.toMatchObject({ status: 413 });
  body.write(Buffer.alloc(13));
  await pending;
  expect(body.listenerCount("data")).toBe(0);
  body.destroy();
});
