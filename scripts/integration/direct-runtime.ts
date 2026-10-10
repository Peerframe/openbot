/** Exercises direct Worker dispatch authority, live Unix-independent sockets and SQL invalidations. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { scenarioStep as check } from "./scenario-step.ts";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "@openbot/db";
import { nodeHelloSchema, browserCommandSchema } from "@openbot/protocol";
import { BrowserSessions } from "../../apps/server/dist/product-browser.js";
import { ProductInvalidations } from "../../apps/server/dist/product-events.js";
import { WorkerRuntime } from "../../apps/server/dist/worker-runtime.js";
import { ownerTransactions } from "../../apps/server/dist/owner-transaction.js";
import type {
  AuthorizedProductOperation,
  ProductRequest,
} from "../../apps/server/dist/product-identity.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export async function qualifyDirectRuntime(options: {
  databaseUrl: string;
  origin: string;
  cookie: string;
}) {
  const database = createDatabase(options.databaseUrl),
    sql = database.client,
    store = ownerTransactions(options.databaseUrl);
  const direct = new WorkerRuntime(options.databaseUrl, { browserRoutes: {}, pageOrigins: {}, humanControl: false, legacyHumanControl: true });
  // A second, isolated transport only exercises the direct dispatch component. Public
  // workspace/Node projections are covered by the complete Server Worker scenario.
  const transport = createServer((_request, reply) => { reply.writeHead(404); reply.end(); });
  await new Promise<void>((resolve) => transport.listen(0, "127.0.0.1", resolve));
  const address = transport.address(); assert(address && typeof address !== "string");
  const transportOrigin = `http://127.0.0.1:${address.port}`;
  direct.registry.attach(transport, transportOrigin);
  const browser = new BrowserSessions(options.databaseUrl),
    signal = AbortSignal.timeout(90000);
  const token = randomBytes(32).toString("base64url"),
    hash = digest(token),
    sessionId = randomUUID(),
    nodeId = "p3-runtime-" + randomUUID();
  const owner: AuthorizedProductOperation = (work, abort, isolation) =>
    store.run(token, abort ?? signal, work, true, isolation);
  const runtime = direct.access(token, "127.0.0.1");
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
    cookie = options.cookie,
  ) => {
    const response = await fetch(options.origin + path, {
      method,
      headers: {
        Host: new URL(options.origin).host,
        Origin: options.origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12000),
    });
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) : null };
  };
  const sockets: WebSocket[] = [];
  let botId = "";
  const commands: unknown[] = [];
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  try {
    await sql`INSERT INTO auth_sessions(id,token_digest,owner_id,expires_at) VALUES(${sessionId},${hash},'owner',clock_timestamp()+interval '5 minutes')`;
    await check("retired private ports are absent at public ingress", async () => {
      for (const operation of ["snapshot", "detach", "browser-command"])
        assert.equal((await api("/_openbot/p4/" + operation)).status, 404);
      assert.equal((await api("/api/v1/workspace")).status, 200);
    });
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
                await sql`SELECT count(*) AS n FROM pg_stat_activity WHERE application_name='openbot-transactions' AND wait_event_type='Lock' AND query LIKE '%FROM message_reactions%'`;
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
      "",
    );
    assert.equal(enrollment.status, 201);
    const url = new URL("/ws/nodes", transportOrigin);
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
    await check("direct projection uses the authenticated live registry", async () => {
      const snapshot = await runtime.snapshot(signal);
      assert.equal(snapshot.nodes.length, 1);
      assert.equal(snapshot.nodes[0]!.id, nodeId);
      assert.equal(snapshot.bindings[0]!.nodeId, nodeId);
    });
    const view = await browser.open(owner, botId, context, signal);
    await check(
      "real direct socket dispatch claims one ticket; replay and wire substitution never send again",
      async () => {
        const result = await browser.command(owner, view.id, { kind: "observe" }, context, signal);
        assert.equal(result.frame?.base64, png.toString("base64"));
        assert.equal(commands.length, 1);
        assert(captured);
        await assert.rejects(runtime.command(captured, signal), (error: unknown) =>
          !!error && typeof error === "object" && "status" in error && error.status === 409);
        assert.equal(commands.length, 1);
        const wire = JSON.parse(captured.wire);
        wire.frame.action = { kind: "take" };
        await assert.rejects(runtime.command({ ...captured, wire: JSON.stringify(wire) }, signal), (error: unknown) =>
          !!error && typeof error === "object" && "status" in error && error.status === 403);
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
      "Owner revocation after admission refuses the direct effect before socket dispatch",
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
    await check("loss of the human/Agent gate before dispatch refuses the effect", async () => {
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
            await sql`SELECT pid FROM pg_stat_activity WHERE application_name='openbot-events'`,
          seen = new Set(before.map((row) => row.pid));
        const listener = new ProductInvalidations(options.databaseUrl);
        await listener.start();
        try {
          const [owned] = (
            await sql`SELECT pid FROM pg_stat_activity WHERE application_name='openbot-events'`
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
          assert.throws(() => listener.current(), /Server request refused/);
        } finally {
          await listener.close();
        }
      },
    );
  } finally {
    await browser.close();
    await direct.close();
    await new Promise<void>((resolve, reject) => transport.close((error) => error ? reject(error) : resolve()));
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
