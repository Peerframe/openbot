/** Preserves bounded-download retry/integrity assertions from the former Python fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  downloadBrowserSource,
  patchListener,
  prepareBrowserUpstream,
  verifyBrowserUpstream,
  type UpstreamIO,
} from "./product-browser-upstream.ts";
const content = Buffer.from("Synthetic upstream license\n"),
  entry = {
    path: "LICENSE",
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
const manifest = { repository: "reviewed/example", commit: "a".repeat(40), files: [entry] };
function mock(outcomes: (Response | Error)[]) {
  const calls: { url: string; options: RequestInit | undefined }[] = [],
    sleeps: number[] = [];
  const io: UpstreamIO = {
    fetch: async (input, options) => {
      calls.push({ url: String(input), options });
      const value = outcomes.shift();
      assert(value);
      if (value instanceof Error) throw value;
      return value;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { io, calls, sleeps };
}
const response = (body = content) => new Response(body);
test("two network failures then success retain fixed URL, bounds and backoff", async () => {
  const f = mock([
    new TypeError("reset"),
    new DOMException("deadline", "TimeoutError"),
    response(),
  ]);
  assert.deepEqual(await downloadBrowserSource(entry, manifest, f.io), content);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.sleeps, [1000, 2000]);
  for (const call of f.calls) {
    assert.equal(
      call.url,
      `https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/LICENSE`,
    );
    assert(call.options?.signal);
    assert.equal(call.options.redirect, "error");
  }
});
test("response read network failures are retried", async () => {
  const broken = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("reset during read"));
        },
      }),
    );
  const f = mock([broken(), broken(), response()]);
  assert.deepEqual(await downloadBrowserSource(entry, manifest, f.io), content);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.sleeps, [1000, 2000]);
});
test("server errors retry twice then succeed", async () => {
  const f = mock([
    new Response(null, { status: 500 }),
    new Response(null, { status: 503 }),
    response(),
  ]);
  assert.deepEqual(await downloadBrowserSource(entry, manifest, f.io), content);
  assert.deepEqual(f.sleeps, [1000, 2000]);
});
for (const status of [0, 502])
  test(`transport/server failures stop after three attempts: ${status}`, async () => {
    const failure = new TypeError("network"),
      f = mock(
        Array.from({ length: 3 }, () => (status ? new Response(null, { status }) : failure)),
      );
    await assert.rejects(downloadBrowserSource(entry, manifest, f.io));
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.sleeps, [1000, 2000]);
  });
for (const status of [400, 403, 404, 429, 600])
  test(`non-server HTTP ${status} never retries`, async () => {
    const r =
        status === 600
          ? ({ ok: false, status, body: null } as Response)
          : new Response(null, { status }),
      f = mock([r]);
    await assert.rejects(downloadBrowserSource(entry, manifest, f.io));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.sleeps, []);
  });
for (const [index, bytes] of [
  content.subarray(1),
  Buffer.concat([content, Buffer.from("extra")]),
  Buffer.alloc(content.length, 88),
].entries())
  for (const prior of [0, 1])
    test(`integrity refusal never retries: ${index}/${prior}`, async () => {
      const f = mock([...(prior ? [new TypeError("reset")] : []), response(bytes)]);
      await assert.rejects(
        downloadBrowserSource(entry, manifest, f.io),
        /Public upstream hash mismatch/,
      );
      assert.equal(f.calls.length, prior + 1);
      assert.deepEqual(f.sleeps, prior ? [1000] : []);
    });
test("oversized streaming body is cancelled at expected bytes plus one", async () => {
  let pulls = 0,
    cancelled = false;
  const body = new ReadableStream({
      pull(c) {
        pulls++;
        c.enqueue(Buffer.alloc(entry.bytes + 10));
      },
      cancel() {
        cancelled = true;
      },
    }),
    f = mock([new Response(body)]);
  await assert.rejects(downloadBrowserSource(entry, manifest, f.io), /hash mismatch/);
  assert(cancelled);
  assert(pulls <= 2);
  assert.equal(f.calls.length, 1);
});
test("prepared fixture verifies exact source/dependencies; local write failures never redownload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbot-upstream-test-"));
  try {
    const root = join(dir, "upstream"),
      f = mock([response()]);
    await prepareBrowserUpstream(root, manifest, f.io);
    await verifyBrowserUpstream(root, manifest);
    assert.deepEqual(await readFile(join(root, "LICENSE")), content);
    await writeFile(join(root, "package.json"), "{}");
    await assert.rejects(verifyBrowserUpstream(root, manifest), /dependencies changed/);
    const other = join(dir, "other"),
      g = mock([response()]);
    g.io.fetch = async () => {
      g.calls.push({ url: "fixed", options: undefined });
      await mkdir(join(other, "LICENSE"));
      return response();
    };
    await assert.rejects(prepareBrowserUpstream(other, manifest, g.io));
    assert.equal(g.calls.length, 1);
    assert.deepEqual(g.sleeps, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("loopback patch has exactly one original marker and reversible bytes", () => {
  const original = Buffer.from("first\n  port: PORT,\nlast"),
    patched = patchListener(original);
  assert.equal(patched.toString(), 'first\n  hostname: "127.0.0.1",\n  port: PORT,\nlast');
  assert.deepEqual(patchListener(patched, true), original);
  for (const bytes of [Buffer.alloc(0), Buffer.concat([original, original])])
    assert.throws(() => patchListener(bytes));
  assert.throws(() => patchListener(original, true));
});
