import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "@openbot/db";
import { nodeHelloSchema, browserCommandSchema } from "@openbot/protocol";
import { BrowserSessions } from "../apps/server-ts/dist/product-browser.js";
import { ProductInvalidations } from "../apps/server-ts/dist/product-events.js";
import { RuntimePort } from "../apps/server-ts/dist/runtime-port.js";
import { ownerTransactions } from "../apps/server-ts/dist/owner-transaction.js";
import type {
  AuthorizedProductOperation,
  ProductRequest,
} from "../apps/server-ts/dist/product-identity.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export async function qualifyP3Completion(options: {
  databaseUrl: string;
  origin: string;
  privateOrigin: string;
  cookie: string;
}) {
  const database = createDatabase(options.databaseUrl),
    sql = database.client,
    store = ownerTransactions(options.databaseUrl);
  const port = new RuntimePort(
    options.privateOrigin,
    options.origin,
    options.origin.startsWith("https:"),
  );
  const browser = new BrowserSessions(options.databaseUrl),
    signal = AbortSignal.timeout(90000),
    cookieName = options.cookie.split("=")[0]!;
  const token = randomBytes(32).toString("base64url"),
    hash = digest(token),
    sessionId = randomUUID(),
    nodeId = "p3-runtime-" + randomUUID();
  const credentialCookie = cookieName + "=" + token;
  const owner: AuthorizedProductOperation = (work, abort, isolation) =>
    store.run(token, abort ?? signal, work, true, isolation);
  const runtime = port.access(token, "127.0.0.1");
  let captured: { ticketId: string; wire: string } | undefined,
    beforeCommand: (() => Promise<void>) | undefined;
  const context: ProductRequest = {
    query: new URLSearchParams(),
    headers: {},
    ownerDigest: hash,
    dispatchProof: (wire) => digest("openbot:browser-dispatch:v1\0" + token + "\0" + wire),
    runtime: {
      ...runtime,
      command: async (dispatch, bound) => {
        captured = dispatch;
        await beforeCommand?.();
        return runtime.command(dispatch, bound);
      },
    },
  };
  const api = async (
    path: string,
    method = "GET",
    body?: unknown,
    privateCall = false,
    cookie = options.cookie,
  ) => {
    const response = await fetch((privateCall ? options.privateOrigin : options.origin) + path, {
      method,
      headers: {
        Host: new URL(options.origin).host,
        Origin: options.origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(privateCall ? { Forwarded: "for=127.0.0.1" } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12000),
    });
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) : null };
  };
  const check = async (name: string, operation: () => Promise<void>) => {
    await operation();
    checks.push(name);
    console.log("p3-completion: " + name);
  };
  const checks: string[] = [],
    sockets: WebSocket[] = [];
  let botId = "";
  const commands: unknown[] = [];
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  try {
    await sql`INSERT INTO auth_sessions(id,token_digest,owner_id,expires_at) VALUES(${sessionId},${hash},'owner',clock_timestamp()+interval '5 minutes')`;
    await check(
      "all 17 remaining public paths quarantine in Python; private port is absent at public ingress",
      async () => {
        const id = randomUUID();
        const routes: [string, string][] = [
          ["GET", "/api/v1/workspace"],
          ["GET", "/api/v1/bootstrap"],
          ["GET", "/api/v1/workspace/events"],
          ["GET", `/api/v1/channels/${id}/events`],
          ["GET", `/api/v1/bots/${id}/export/preview`],
          ["GET", `/api/v1/bots/${id}/export`],
          ["POST", "/api/v1/employees/import/preview"],
          ["POST", "/api/v1/employees/import/activate"],
          ["GET", "/api/v1/nodes"],
          ["GET", "/api/v1/node-identities"],
          ["POST", "/api/v1/nodes/enrollment-tokens"],
          ["POST", "/api/v1/nodes/enroll"],
          ["POST", `/api/v1/nodes/${id}/revoke`],
          ["POST", `/api/v1/bots/${id}/browser`],
          ["POST", `/api/v1/bots/${id}/browser/maintenance`],
          ["POST", `/api/v1/browser-sessions/${id}/commands`],
          ["DELETE", `/api/v1/browser-sessions/${id}`],
        ];
        for (const [method, path] of routes) {
          const r = await api(path, method, undefined, true);
          assert.equal(r.status, 503, path);
          assert.deepEqual(r.body, { error: "operation_owned_by_ts" });
        }
        for (const operation of ["snapshot", "detach", "browser-command"])
          assert.equal((await api("/_openbot/p4/" + operation)).status, 404);
        assert.equal((await api("/_openbot/p4/snapshot", "GET", undefined, true, "")).status, 401);
        assert.equal((await api("/api/v1/workspace", "GET")).status, 200);
      },
    );
    await check(
      "normal page burst queues behind four active product transactions without returning 503",
      async () => {
        const channel = await api("/api/v1/channels", "POST", {
          name: "Concurrent page reads",
          botIds: [],
        });
        assert.equal(channel.status, 201);
        const path = `/api/v1/channels/${channel.body.channel.id}/reactions`;
        const active: Promise<Awaited<ReturnType<typeof api>>>[] = [];
        let additional: Promise<Awaited<ReturnType<typeof api>>> | undefined;
        try {
          await sql.begin(async (lock) => {
            await lock`LOCK TABLE message_reactions IN ACCESS EXCLUSIVE MODE`;
            for (let n = 0; n < 4; n++) active.push(api(path));
            let count = 0;
            for (let n = 0; n < 70; n++) {
              const [row] =
                await sql`SELECT count(*) AS n FROM pg_stat_activity WHERE application_name='openbot-ts-product' AND wait_event_type='Lock' AND query LIKE '%FROM message_reactions%'`;
              count = Number(row!.n);
              if (count === 4) break;
              await delay(10);
            }
            assert.equal(count, 4, "The real product pool must have four blocked reads.");
            additional = api("/api/v1/workspace");
            await delay(100);
          });
          const results = await Promise.all([...active, additional!]);
          assert.deepEqual(
            results.map((result) => result.status),
            [200, 200, 200, 200, 200],
          );
        } finally {
          await Promise.allSettled(active);
          await additional;
        }
      },
    );
    const bot = await api("/api/v1/bots", "POST", {
      name: "P3 runtime " + randomUUID(),
      role: "Disposable authority qualification",
      computerProfile: "docker-linux",
    });
    assert.equal(bot.status, 201);
    botId = bot.body.bot.id;
    const issued = await api("/api/v1/nodes/enrollment-tokens", "POST", { nodeId });
    assert.equal(issued.status, 201);
    const enrollment = await api(
      "/api/v1/nodes/enroll",
      "POST",
      { nodeId, token: issued.body.token },
      false,
      "",
    );
    assert.equal(enrollment.status, 201);
    const url = new URL("/ws/nodes", options.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    sockets.push(socket);
    const ack = new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "server.ack") {
            assert.equal(message.accepted, true);
            resolve();
            return;
          }
          const command = browserCommandSchema.parse(message);
          commands.push(command);
          socket.send(
            JSON.stringify({
              type: "browser.result",
              protocolVersion: "0.9.0",
              nodeId,
              requestId: command.requestId,
              sessionId: command.sessionId,
              ok: true,
              frame: {
                base64: png.toString("base64"),
                width: 1,
                height: 1,
                capturedAt: new Date().toISOString(),
                url: "https://fixture.invalid/no-durable-page",
              },
            }),
          );
        } catch (error) {
          reject(error);
          socket.close();
        }
      });
      socket.addEventListener("error", reject, { once: true });
    });
    await once(socket, "open", { signal });
    socket.send(
      JSON.stringify(
        nodeHelloSchema.parse({
          type: "node.hello",
          protocolVersion: "0.9.0",
          nodeId,
          name: "P3 disposable peer",
          platform: "linux",
          capabilities: ["browser", "screenshot"],
          capabilityManifest: [
            { id: "browser.session", version: 1, providerId: "docker", constraints: {} },
          ],
          maxConcurrentRuns: 1,
          credential: enrollment.body.credential,
          sentAt: new Date().toISOString(),
        }),
      ),
    );
    await Promise.race([
      ack,
      delay(5000, undefined, { signal }).then(() => {
        throw new Error("P3 peer acknowledgement timeout.");
      }),
    ]);
    await check("workspace and Node projections use actual live registry metadata", async () => {
      const workspace = await api("/api/v1/workspace"),
        nodes = await api("/api/v1/nodes");
      assert.equal(workspace.status, 200);
      assert.equal(nodes.status, 200);
      assert(workspace.body.nodes.some((node: { id: string }) => node.id === nodeId));
      assert(nodes.body.nodes.some((node: { id: string }) => node.id === nodeId));
      assert.equal(workspace.body.counts.connectedNodes, workspace.body.nodes.length);
    });
    const view = await browser.open(owner, botId, context, signal);
    await check(
      "real P4 socket dispatch claims one ticket; replay and wire substitution never send again",
      async () => {
        const result = await browser.command(owner, view.id, { kind: "observe" }, context, signal);
        assert.equal(result.frame?.base64, png.toString("base64"));
        assert.equal(commands.length, 1);
        assert(captured);
        const replay = await api(
          "/_openbot/p4/browser-command",
          "POST",
          captured,
          true,
          credentialCookie,
        );
        assert.equal(replay.status, 409);
        assert.equal(commands.length, 1);
        const wire = JSON.parse(captured.wire);
        wire.frame.action = { kind: "take" };
        const changed = await api(
          "/_openbot/p4/browser-command",
          "POST",
          { ...captured, wire: JSON.stringify(wire) },
          true,
          credentialCookie,
        );
        assert.equal(changed.status, 403);
        assert.equal(commands.length, 1);
        const eventRows =
          await sql`SELECT type,payload FROM run_events WHERE bot_id=${botId} AND type IN ('BROWSER_TRANSPORT_ADMITTED','BROWSER_TRANSPORT_CLAIMED')`;
        assert.equal(eventRows.length, 2);
        const text = JSON.stringify(eventRows);
        assert(
          !text.includes(token) &&
            !text.includes(png.toString("base64")) &&
            !text.includes("no-durable-page"),
        );
      },
    );
    await check(
      "Owner revocation after TS admission refuses the private effect before socket dispatch",
      async () => {
        const count = commands.length;
        beforeCommand = async () => {
          await sql`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=${sessionId}`;
        };
        try {
          await assert.rejects(
            browser.command(owner, view.id, { kind: "observe" }, context, signal),
          );
          assert.equal(commands.length, count);
        } finally {
          beforeCommand = undefined;
          await sql`UPDATE auth_sessions SET revoked_at=NULL WHERE id=${sessionId}`;
        }
      },
    );
    await check(
      "Bot profile change after admission refuses the effect and retains no frame",
      async () => {
        const count = commands.length;
        beforeCommand = async () => {
          await sql`UPDATE bots SET computer_profile='none' WHERE id=${botId}`;
        };
        try {
          await assert.rejects(
            browser.command(owner, view.id, { kind: "observe" }, context, signal),
          );
          assert.equal(commands.length, count);
        } finally {
          beforeCommand = undefined;
          await sql`UPDATE bots SET computer_profile='docker-linux' WHERE id=${botId}`;
        }
      },
    );
    await check("loss of the TS human/Agent gate before dispatch refuses the effect", async () => {
      const count = commands.length;
      beforeCommand = async () => {
        assert(captured);
        const [ticket] = await sql`SELECT payload FROM run_events WHERE id=${captured.ticketId}`;
        assert(ticket);
        await sql`SELECT pg_terminate_backend(${ticket.payload.gatePid})`;
      };
      try {
        await assert.rejects(browser.command(owner, view.id, { kind: "observe" }, context, signal));
        assert.equal(commands.length, count);
      } finally {
        beforeCommand = undefined;
      }
    });
    await check(
      "one-way PostgreSQL invalidation observes commits, ignores rollback and fails closed on listener loss",
      async () => {
        const before =
            await sql`SELECT pid FROM pg_stat_activity WHERE application_name='openbot-ts-events'`,
          seen = new Set(before.map((row) => row.pid));
        const listener = new ProductInvalidations(options.databaseUrl);
        await listener.start();
        try {
          const [owned] = (
            await sql`SELECT pid FROM pg_stat_activity WHERE application_name='openbot-ts-events'`
          ).filter((row) => !seen.has(row.pid));
          assert(owned);
          await sql`SELECT pg_notify('openbot_product_changed','')`;
          for (let n = 0; n < 100 && listener.current() === 0; n++) await delay(10);
          assert.equal(listener.current(), 1);
          await assert.rejects(
            sql.begin(async (db) => {
              await db`SELECT pg_notify('openbot_product_changed','')`;
              throw new Error("Rollback fixture.");
            }),
          );
          await delay(100);
          assert.equal(listener.current(), 1);
          await sql`SELECT pg_terminate_backend(${owned.pid})`;
          await delay(100);
          assert.throws(() => listener.current(), /Owner write refused/);
        } finally {
          await listener.close();
        }
      },
    );
    console.log(
      `P3 completion boundary qualification passed: ${checks.length}; real SQL and registry/socket, synthetic peer only.`,
    );
  } finally {
    await browser.close();
    port.close();
    await store.close();
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) });
        socket.close();
        await closed;
      }
    }
    await api("/api/v1/nodes/" + nodeId + "/revoke", "POST").catch(() => undefined);
    if (botId) await api("/api/v1/bots/" + botId, "DELETE").catch(() => undefined);
    await sql`DELETE FROM auth_sessions WHERE id=${sessionId}`;
    await database.close();
  }
}
