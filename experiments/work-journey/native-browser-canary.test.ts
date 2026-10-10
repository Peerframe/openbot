/** Actual loopback HTTP/TLS canaries, bounded input and independent cleanup; no native privilege. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openBrowserCanary } from "./native-browser-canary.ts";
import { prepareNativeTls } from "./native-packet-tls.ts";
import { browserCanaryPage } from "./native-browser-page.ts";
import { createHash } from "node:crypto";
test("owned page and state counters preserve the synthetic browser/profile journey", async () => {
  assert.equal(
    createHash("sha256").update(browserCanaryPage).digest("hex"),
    "5050337fb69c903b92ed9d4b3f2fc21c14420d8d12bc83132aa3588f3b23211b",
  );
  const service = await openBrowserCanary({ host: "127.0.0.1", httpPort: 0 });
  const url = "http://127.0.0.1:" + service.http;
  try {
    assert.deepEqual(await (await fetch(url + "/hits")).json(), { requests: 0 });
    const page = await fetch(url + "/");
    assert.equal(page.status, 200);
    assert.equal(await page.text(), browserCanaryPage);
    assert.equal(await (await fetch(url + "/tunnel")).text(), "owned-tunnel");
    const state = {
      text: "synthetic-input",
      submitted: 1,
      stored: "synthetic-input",
      persistentCookie: true,
      sessionCookie: false,
      indexedDB: "synthetic-indexed-value",
    };
    const answer = await fetch(url + "/event", { method: "POST", body: JSON.stringify(state) });
    assert.equal(answer.status, 200);
    assert.equal(await answer.text(), "ok");
    assert.deepEqual(await (await fetch(url + "/state")).json(), state);
    assert.deepEqual(await (await fetch(url + "/hits")).json(), { requests: 2 });
    for (const body of [
      '{"unexpected":1}',
      '{"submitted":"1"}',
      '{"persistentCookie":"true"}',
      '{"__proto__":{}}',
      "[1]",
      "null",
      "not-json",
      "x".repeat(4097),
    ]) {
      const rejected = await fetch(url + "/event", { method: "POST", body });
      assert.equal(rejected.status, 400);
      await rejected.text();
    }
    assert.deepEqual(await (await fetch(url + "/state")).json(), state);
    const missing = await fetch(url + "/other", { method: "POST", body: "{}" });
    assert.equal(missing.status, 404);
    await missing.text();
    await assert.rejects(openBrowserCanary({ host: "127.0.0.1", httpPort: service.http }));
    assert.equal(
      (await fetch(url + "/hits")).status,
      200,
      "A rejected bind does not close the original server",
    );
  } finally {
    await service.close();
  }
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
});
test("actual native TLS listeners keep valid-name, wrong-name and unknown-CA distinctions", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "obp5-native-tls-"));
  let service: Awaited<ReturnType<typeof openBrowserCanary>> | undefined;
  try {
    await prepareNativeTls(root + "/tls");
    service = await openBrowserCanary({
      host: "127.0.0.1",
      httpPort: 0,
      tlsDirectory: root + "/tls",
      tlsPorts: [0, 0],
    });
    const ca = await readFile(root + "/tls/ca.pem");
    const fetchTls = (port: number, servername: string) =>
      new Promise<number>((resolve, reject) => {
        const req = get(
          { hostname: "127.0.0.1", port, path: "/hits", ca, servername, timeout: 2000 },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode!));
          },
        );
        req.once("error", reject);
        req.once("timeout", () => req.destroy(new Error("TLS fixture timeout")));
      });
    assert.equal(await fetchTls(service.tls[0]!, "example.com"), 200);
    await assert.rejects(fetchTls(service.tls[0]!, "wrong.example"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    await assert.rejects(fetchTls(service.tls[1]!, "example.com"), (error: unknown) =>
      /CERT|SELF_SIGNED|VERIFY/.test(String((error as NodeJS.ErrnoException).code)),
    );
  } finally {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
});
