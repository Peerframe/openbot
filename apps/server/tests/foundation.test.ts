/** Exercises pooled SQL ownership, session races and post-commit responses against real PostgreSQL. */
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { disposableDatabase } from "./postgres-fixture.ts";
import { databasePool } from "../src/database-pool.js";
import { DatabaseFence } from "../src/database-fence.js";
import { LOCK_NAMESPACE } from "../src/database-locks.js";
import { ownerTransactions } from "../src/owner-transaction.js";
import { sessionDigest } from "../src/owner-session.js";
import { boundedAdmission } from "../src/request-limits.js";
import { HttpFailure } from "../src/http-errors.js";

const control = vi.hoisted(() => ({ afterCommit: async () => {} }));
vi.mock("../src/product-identity.js", async (original) => {
  const actual = await original<typeof import("../src/product-identity.js")>();
  return {
    ...actual,
    identityRoutes: [{
      method: "POST", path: "/api/v1/channels", kind: "product", maxBytes: 0, status: 201,
      execute: async () => { throw new Error("remote operation required"); },
      remote: async (owner: import("../src/product-identity.js").AuthorizedProductOperation) => {
        const result = await owner(async (db) => {
          await db`INSERT INTO p5_effects(id) VALUES ('once')`;
          return { committed: true };
        });
        await control.afterCommit();
        return result;
      },
    }],
  };
});
import { createEntry } from "../src/app.js";

let fixture: Awaited<ReturnType<typeof disposableDatabase>>;
beforeAll(async () => {
  fixture = await disposableDatabase();
  await fixture.sql`CREATE TABLE p5_effects(id text PRIMARY KEY)`;
});
afterAll(async () => { await fixture?.close(); });
async function session(milliseconds = 60000) {
  const token = randomBytes(32).toString("base64url");
  await fixture.sql`INSERT INTO auth_sessions(id,token_digest,expires_at) VALUES
    (${randomUUID()},${sessionDigest(token)},clock_timestamp()+${milliseconds}*interval '1 millisecond')`;
  return token;
}

it("shares four physical transaction connections and closes only after the final owner", async () => {
  const leases = Array.from({ length: 12 }, () => databasePool(fixture.url));
  try {
    const pids = await Promise.all(leases.map(async ({ sql }) => {
      const [row] = await sql`SELECT pg_backend_pid() AS pid,pg_sleep(0.025)`;
      return row!.pid;
    }));
    expect(new Set(pids).size).toBeLessThanOrEqual(4);
    await Promise.all(leases.slice(0, -1).map((lease) => lease.close()));
    await expect(leases.at(-1)!.sql`SELECT 1 AS alive`).resolves.toMatchObject([{ alive: 1 }]);
  } finally { await Promise.all(leases.map((lease) => lease.close())); }
});

it("rolls back a mutation when the original session expires before commit", async () => {
  const store = ownerTransactions(fixture.url);
  const token = await session(120);
  try {
    await expect(store.run(token, AbortSignal.timeout(5000), async (db) => {
      await db`INSERT INTO p5_effects(id) VALUES ('expired')`;
      await db`SELECT pg_sleep(0.16)`;
    })).rejects.toMatchObject({ status: 401 });
    expect(await fixture.sql`SELECT id FROM p5_effects WHERE id='expired'`).toHaveLength(0);
  } finally { await store.close(); }
});

it("keeps revocation behind the active mutation and refuses the next request", async () => {
  const store = ownerTransactions(fixture.url);
  const token = await session();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let proceed!: () => void;
  const release = new Promise<void>((resolve) => { proceed = resolve; });
  let revoked = false;
  try {
    const mutation = store.run(token, AbortSignal.timeout(5000), async (db) => {
      await db`INSERT INTO p5_effects(id) VALUES ('revoked-after')`;
      entered(); await release;
      return "committed";
    });
    await ready;
    const revoke = fixture.sql`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=${sessionDigest(token)}`
      .then(() => { revoked = true; });
    await delay(50);
    expect(revoked).toBe(false);
    proceed();
    await expect(mutation).resolves.toBe("committed");
    await revoke;
    await expect(store.preflight(token, AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 401 });
  } finally { proceed?.(); await store.close(); }
});

it("returns the original committed HTTP result when logout happens before the response", async () => {
  const token = await session();
  const origin = "http://127.0.0.1:31763";
  const app = await createEntry({
    host: "127.0.0.1", port: 31763, publicOrigin: origin,
    product: { databaseUrl: fixture.url },
  });
  control.afterCommit = async () => {
    await fixture.sql`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=${sessionDigest(token)}`;
  };
  try {
    const result = await app.inject({ method: "POST", url: "/api/v1/channels", headers: {
      host: "127.0.0.1:31763", origin, cookie: `openbot_session=${token}`,
    } });
    expect(result.statusCode).toBe(201);
    expect(result.json()).toEqual({ committed: true });
    expect(await fixture.sql`SELECT id FROM p5_effects WHERE id='once'`).toHaveLength(1);
  } finally { await app.close(); control.afterCommit = async () => {}; }
});

it("returns an acknowledged result despite a late abort and retains the admission slot until settlement", async () => {
  const abort = new AbortController();
  const admit = boundedAdmission(1, { waitForSettlement: true, committedResult: true });
  const result = admit(abort.signal, async (check) => {
    check(); abort.abort(); await delay(20); return "known commit";
  });
  await expect(admit(new AbortController().signal, async () => "extra")).rejects.toBeInstanceOf(HttpFailure);
  await expect(result).resolves.toBe("known commit");
});

it("reuses advisory connections without leaking locks after success or failure", async () => {
  const gate = new DatabaseFence(fixture.url, LOCK_NAMESPACE.browser, 5000, "browser_busy");
  try {
    const pids = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const operation = gate.run("same", AbortSignal.timeout(5000), async (_signal, pid) => {
        pids.add(pid);
        const [lock] = await fixture.sql`SELECT 1 AS held FROM pg_locks WHERE pid=${pid} AND locktype='advisory' AND classid=${LOCK_NAMESPACE.browser} AND granted`;
        expect(lock?.held).toBe(1);
        if (i % 2) throw new Error("fixture refusal");
        return pid;
      });
      if (i % 2) await expect(operation).rejects.toThrow("fixture refusal");
      else await operation;
      expect(await fixture.sql`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=${LOCK_NAMESPACE.browser}`).toHaveLength(0);
    }
    expect(pids.size).toBeLessThanOrEqual(4);
  } finally { await gate.close(); }
});

it("aborts the original fence when its backend disconnects, without repeating the operation", async () => {
  const gate = new DatabaseFence(fixture.url, LOCK_NAMESPACE.browser, 5000, "browser_busy");
  let calls = 0;
  try {
    await expect(gate.run("disconnect", AbortSignal.timeout(5000), async (signal, pid) => {
      calls++;
      await fixture.sql`SELECT pg_terminate_backend(${pid})`;
      await delay(100, undefined, { signal });
      signal.throwIfAborted();
    })).rejects.toBeDefined();
    expect(calls).toBe(1);
    const recovered = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      gate.run(`recovery-${i}`, AbortSignal.timeout(5000), async () => "new request")));
    expect(recovered).toEqual(Array(4).fill("new request"));
    expect(calls).toBe(1);
    expect(await fixture.sql`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=${LOCK_NAMESPACE.browser}`).toHaveLength(0);
  } finally { await gate.close(); }
});
