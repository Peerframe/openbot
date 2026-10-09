import { randomBytes } from "node:crypto";
import type { lookup } from "node:dns/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { workWebFixture } from "../../../scripts/ts-work-web-fixture.ts";
import { htmlWorkText } from "../dist/public-work-web.js";
import { normalizeWorkSource, PublicWorkWeb, workSourceUrls } from "./public-work-web.js";

let fixture: Awaited<ReturnType<typeof workWebFixture>>;
beforeAll(async () => {
  fixture = await workWebFixture();
});
afterAll(async () => {
  await fixture?.close();
});
it("refuses ambiguous, private, credentialed and alternate HTTPS authorities", () => {
  const authenticated = new URL("https://example.com");
  authenticated.username = "fixture";
  authenticated.password = "example";
  for (const url of [
    authenticated.href,
    "http://example.com",
    "https://example.com:8443",
    "https://localhost",
    "https://a.internal",
    "https://a.test",
    "https://127.0.0.1",
    "https://2130706433",
    "https://127.1",
    "https://0177.0.0.1",
    "https://0x7f000001",
    "https://[::ffff:127.0.0.1]",
    "https://[2002:7f00:1::]",
    "https://example.com.",
    "https://%65xample.com",
  ]) {
    expect(() => normalizeWorkSource(url), url).toThrow();
  }
  expect(normalizeWorkSource("https://EXAMPLE.com:443/a#b")).toBe("https://example.com/a");
  expect(
    workSourceUrls(
      "看 https://example.com， https://example.org。 https://example.com/#a https://example.net/c https://other.org",
    ),
  ).toEqual(["https://example.com/", "https://example.org/", "https://example.net/c"]);
});
it("uses one pinned real TLS connection and isolated HTML conversion with no page authority", async () => {
  fixture.setMode("normal");
  const before = fixture.requests.length;
  let gates = 0;
  const result = await fixture.client.read(
    "https://example.com/evidence#ignored",
    async () => {
      gates++;
    },
    new AbortController().signal,
  );
  expect(result.text).toContain("Readable & bounded evidence");
  expect(result.text).not.toContain("PRIVATE");
  expect(result.url).toBe("https://example.com/evidence");
  expect(gates).toBe(1);
  expect(fixture.requests.length).toBe(before + 1);
  const request = fixture.requests.at(-1)!;
  expect(request.headers.host).toBe("example.com");
  expect(request.headers.cookie).toBeUndefined();
  expect(request.headers.authorization).toBeUndefined();
  expect(request.headers["accept-encoding"]).toBe("identity");
  fixture.setBody(Buffer.from("<p>" + "中".repeat(5000) + "</p>"));
  const bounded = await fixture.client.read(
    "https://example.com/evidence",
    async () => {},
    new AbortController().signal,
  );
  expect(bounded.truncated).toBe(true);
  expect(Buffer.byteLength(bounded.text)).toBe(6000);
  expect(bounded.text).not.toContain("�");
});
it("rejects parser depth, child and input limits without executing markup", async () => {
  for (const html of [
    "<div>".repeat(42) + "x" + "</div>".repeat(42),
    "<div>" + "<br>".repeat(1001) + "</div>",
    "x".repeat(524289),
  ])
    await expect(htmlWorkText(Buffer.from(html), new AbortController().signal)).rejects.toThrow();
  const text = await htmlWorkText(
    Buffer.from(
      '<h1>Title</h1><p>A &amp; <a href="http://127.0.0.1/secret">visible link</a></p><table><tr><th>Item</th><th>Value</th></tr><tr><td>One</td><td>Two</td></tr></table><script>SECRET</script><style>SECRET</style><iframe>SECRET</iframe><noscript>SECRET</noscript><img alt="SECRET" src="https://evil.org"><template>SECRET</template>',
    ),
    new AbortController().signal,
  );
  for (const word of ["Title", "A &", "visible link", "Item", "Value", "One", "Two"])
    expect(text).toContain(word);
  for (const word of ["SECRET", "127.0.0.1", "href", "evil.org"]) expect(text).not.toContain(word);
});
it("does not follow redirects or accept compressed, oversized or invalid UTF-8 responses", async () => {
  for (const mode of ["redirect", "encoding", "large"]) {
    fixture.setMode(mode);
    const before = fixture.requests.length;
    await expect(
      fixture.client.read(
        "https://example.com/invalid",
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fixture.requests.length).toBe(before + 1);
  }
  fixture.setMode("normal");
  fixture.setBody(Buffer.from([0xc3, 0x28]));
  await expect(
    fixture.client.read(
      "https://example.com/invalid",
      async () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it("blocks mixed DNS, cancellation and denied fresh authority before sending", async () => {
  let gate = 0;
  const mixed = new PublicWorkWeb((async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]) as typeof lookup);
  await expect(
    mixed.read(
      "https://example.com",
      async () => {
        gate++;
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(gate).toBe(0);
  const abort = new AbortController(),
    stalled = new PublicWorkWeb((async () => new Promise(() => {})) as typeof lookup);
  const pending = expect(
    stalled.read(
      "https://example.com",
      async () => {
        gate++;
      },
      abort.signal,
    ),
  ).rejects.toThrow();
  abort.abort();
  await pending;
  expect(gate).toBe(0);
  const before = fixture.requests.length;
  await expect(
    fixture.client.read(
      "https://example.com",
      async () => {
        throw new Error("revoked");
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(fixture.requests.length).toBe(before);
});
it("sends only the explicitly selected search credential, retains bounded Tavily and Kimi evidence", async () => {
  fixture.setMode("normal");
  const key = randomBytes(24).toString("hex");
  const tavily = JSON.parse(
    await fixture.client.search(
      "query",
      { provider: "tavily", revision: "1", key },
      async () => {},
      new AbortController().signal,
    ),
  );
  expect(tavily.results).toHaveLength(1);
  expect(fixture.requests.at(-1)!.headers.authorization).toBe("Bearer " + key);
  expect(JSON.parse(fixture.requests.at(-1)!.body)).toMatchObject({
    query: "query",
    max_results: 5,
  });
  const kimi = await fixture.client.search(
    "query",
    {
      provider: "kimi",
      revision: "2",
      key,
      model: {
        connectionId: "fixture",
        revision: 2,
        modelId: "kimi-k3",
        protocol: "openai-chat",
        presetId: "kimi",
        baseUrl: "https://api.moonshot.cn/v1",
      },
    },
    async () => {},
    new AbortController().signal,
  );
  expect(kimi).toBe("Synthetic Kimi search evidence");
});
