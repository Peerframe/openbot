/** Qualifies protected TLS credentials, direct HTTPS ingress and Worker WSS lifecycle. */
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { WebSocket } from "ws";
import { issueTlsFixture } from "../../../scripts/tls-fixture.ts";
import { createEntry } from "./app.js";
import { type EntryOptions, validateOptions } from "./config.js";
import { entryTls } from "./tls.js";
import { WorkerHostRegistry } from "./worker-host-registry.js";
import { protocolVersion } from "@openbot/protocol";

// Operator file ownership is POSIX-only; Windows retains the existing HTTP transport suite.
describe.skipIf(!process.getuid)("POSIX TLS entry", () => {
  let root: string;
  let tls: NonNullable<EntryOptions["tls"]>;
  let ca: Buffer;
  const options = () => ({
    publicOrigin: "https://entry.test",
    host: "127.0.0.1" as const,
    port: 3101,
    tls,
  });
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "openbot-entry-tls-")));
    const fixture = await issueTlsFixture(root);
    tls = { certificatePath: fixture.certificatePath, privateKeyPath: fixture.privateKeyPath };
    ca = await readFile(fixture.caPath);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  describe("TLS operator boundary", () => {
    it("refuses TLS when POSIX UID support is unavailable", async () => {
      vi.stubGlobal("process", Object.create(process, { getuid: { value: undefined } }));
      try {
        await assert.rejects(entryTls(options()), /TLS certificate\/key configuration is invalid/);
      } finally {
        vi.unstubAllGlobals();
      }
    });
    it("requires scheme, paired paths and public TLS together", () => {
      assert.throws(() => validateOptions({ ...options(), publicOrigin: "http://entry.test" }));
      assert.throws(() =>
        validateOptions({
          ...options(),
          tls: { ...tls, privateKeyPath: "relative.key" },
        }),
      );
      const plain = options();
      delete (plain as EntryOptions).tls;
      assert.throws(() =>
        validateOptions({
          ...plain,
          host: "0.0.0.0",
          publicOrigin: "http://entry.test",
        }),
      );
      assert.equal(validateOptions(options()).tls?.certificatePath, tls.certificatePath);
    });
    it("checks server/CA purpose, SAN, key match, dates and private permissions before creating a listener", async () => {
      await entryTls(options());
      const clientDirectory = join(root, "client-only");
      await mkdir(clientDirectory, { mode: 0o700 });
      const clientOnly = await issueTlsFixture(clientDirectory, "clientAuth");
      await assert.rejects(entryTls({ ...options(), tls: clientOnly }));
      await assert.rejects(
        createEntry({ ...options(), publicOrigin: "https://wrong.test" }),
        /TLS certificate\/key configuration is invalid/,
      );
      const wrong = join(root, "wrong.key");
      await copyFile(join(root, "ca.key"), wrong);
      await chmod(wrong, 0o600);
      await assert.rejects(entryTls({ ...options(), tls: { ...tls, privateKeyPath: wrong } }));
      await assert.rejects(
        entryTls({
          ...options(),
          tls: {
            certificatePath: join(root, "ca.pem"),
            privateKeyPath: join(root, "ca.key"),
          },
        }),
      );
      await chmod(tls.privateKeyPath, 0o644);
      await assert.rejects(entryTls(options()));
      await chmod(tls.privateKeyPath, 0o600);
      const now = vi.spyOn(Date, "now").mockReturnValue(0);
      await assert.rejects(entryTls(options()));
      now.mockReturnValue(4102444800000);
      await assert.rejects(entryTls(options()));
      now.mockRestore();
    });
    it("refuses malformed/oversize files, symlinks and shared inodes", async () => {
      for (const [name, body] of [
        ["invalid.pem", "private-invalid-value"],
        ["huge.pem", "x".repeat(65537)],
      ] as const) {
        const path = join(root, name);
        await writeFile(path, body, { mode: 0o600 });
        await assert.rejects(
          entryTls({ ...options(), tls: { ...tls, certificatePath: path } }),
          (error) =>
            error instanceof Error &&
            error.message === "TLS certificate/key configuration is invalid.",
        );
      }
      const alias = join(root, "linked.key");
      await symlink(tls.privateKeyPath, alias);
      await assert.rejects(entryTls({ ...options(), tls: { ...tls, privateKeyPath: alias } }));
      const shared = join(root, "shared.key");
      await link(tls.privateKeyPath, shared);
      try {
        await assert.rejects(entryTls(options()));
      } finally {
        await rm(shared);
      }
      const dirAlias = join(root, "alias");
      await symlink(root, dirAlias);
      await assert.rejects(
        entryTls({
          ...options(),
          tls: { ...tls, privateKeyPath: join(dirAlias, "server.key") },
        }),
      );
    });
  });

  describe("verified HTTPS and WSS transport", () => {
    it("bounds an unfinished TLS handshake and closes pending TCP sockets on shutdown", async () => {
      const app = await createEntry(options());
      let stalled: ReturnType<typeof connect> | undefined;
      let pending: ReturnType<typeof connect> | undefined;
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address();
        assert(address && typeof address !== "string");
        assert.equal(app.server.maxConnections, 192);
        stalled = connect(address.port, "127.0.0.1");
        stalled.on("error", () => {});
        await once(stalled, "connect");
        const started = Date.now();
        await once(stalled, "close");
        assert(Date.now() - started < 6500);
        pending = connect(address.port, "127.0.0.1");
        pending.on("error", () => {});
        await once(pending, "connect");
        const closed = once(pending, "close");
        await app.close();
        await closed;
      } finally {
        stalled?.destroy();
        pending?.destroy();
        await app.close();
      }
    }, 10000);
    it("keeps the fixed peer/header/bytes path and refuses untrusted TLS, plaintext and forged metadata", async () => {
      let dispatches = 0;
      const app = await createEntry(options());
      app.get("/", (request, reply) => {
        dispatches++;
        assert.equal(request.ip, "127.0.0.1");
        assert.equal(request.headers.forwarded, undefined);
        assert.equal(request.headers.origin, "https://entry.test");
        assert.equal(request.headers.cookie, "__Host-openbot_session=synthetic");
        return reply.header("Set-Cookie", "__Host-openbot_session=synthetic; Secure; HttpOnly; SameSite=Strict; Path=/")
          .type("application/octet-stream").send(Buffer.from([0, 255, 13, 10]));
      });
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address();
        assert(address && typeof address !== "string");
        const call = (headers: Record<string, string> = {}, trusted = true) =>
          new Promise<{
            status: number | undefined;
            cookie: string[] | undefined;
            body: Buffer;
          }>((resolve, reject) => {
            const request = httpsRequest(
              {
                hostname: "127.0.0.1",
                port: address.port,
                servername: "entry.test",
                ...(trusted ? { ca } : {}),
                agent: false,
                headers: {
                  Host: "entry.test",
                  Origin: "https://entry.test",
                  Cookie: "__Host-openbot_session=synthetic",
                  ...headers,
                },
              },
              (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                response.on("end", () =>
                  resolve({
                    status: response.statusCode,
                    cookie: response.headers["set-cookie"],
                    body: Buffer.concat(chunks),
                  }),
                );
                response.on("error", reject);
              },
            );
            request.setTimeout(5000, () => request.destroy(new Error("request deadline")));
            request.on("error", reject);
            request.end();
          });
        await assert.rejects(call({}, false));
        assert.equal(dispatches, 0);
        const result = await call();
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, Buffer.from([0, 255, 13, 10]));
        assert(result.cookie?.[0]?.includes("Secure"));
        assert.equal((await call({ Forwarded: "for=192.0.2.1" })).status, 400);
        assert.equal((await call({ Host: "wrong.test" })).status, 400);
        assert.equal(dispatches, 1);
        await assert.rejects(
          new Promise((resolve, reject) => {
            const request = httpRequest({ hostname: "127.0.0.1", port: address.port }, resolve);
            request.on("error", reject);
            request.end();
          }),
        );
        assert.equal(dispatches, 1);
      } finally {
        await app.close();

      }
    });
    it("authenticates the actual Worker registry over WSS and closes active peers", async () => {
      const app = await createEntry(options());
      // Unit composition supplies a synthetic identity store to the real registry.
      app.server.removeAllListeners("upgrade");
      const registry = new WorkerHostRegistry({
        authenticate: async () => "a".repeat(64), connectionEvent: async () => {},
        fence: { run: async (_key, signal, operation) => operation(signal, 0) },
      }, { run: () => {}, unavailable: () => {} });
      registry.attach(app.server, "https://entry.test");
      let client: WebSocket | undefined;
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address();
        assert(address && typeof address !== "string");
        const peerOptions: WebSocket.ClientOptions & { servername: string } = {
          ca, servername: "entry.test", headers: { Host: "entry.test" },
        };
        client = new WebSocket(`wss://127.0.0.1:${address.port}/ws/nodes`, peerOptions);
        await once(client, "open");
        const ack = once(client, "message");
        client.send(JSON.stringify({ type: "node.hello", protocolVersion, nodeId: "tls-worker", name: "Fixture", platform: "linux", capabilities: ["browser"], maxConcurrentRuns: 2, capabilityManifest: [{ id: "browser.session", version: 1, providerId: "docker" }], credential: "obn_" + "q".repeat(43), sentAt: new Date().toISOString() }));
        assert.equal(JSON.parse((await ack)[0].toString()).accepted, true);
        const pong = once(client, "pong");
        client.ping("alive");
        assert.equal((await pong)[0].toString(), "alive");
        const closed = once(client, "close");
        await registry.close();
        await closed;
      } finally {
        client?.terminate();
        await registry.close();
        await app.close();
      }
    });
  });
});
