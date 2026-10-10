/** Owns Node enrollment, credential lifecycle and authenticated connection audit. */
import { LOCK_NAMESPACE } from "./database-locks.js";
import { databasePool } from "./database-pool.js";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  createNodeEnrollmentTokenInputSchema,
  exchangeNodeEnrollmentInputSchema,
  nodeIdSchema,
  nodeIdentitiesResponseSchema,
} from "@openbot/protocol";
import { boundedAdmission } from "./request-limits.js";
import { clientDigest, digest } from "./owner-auth-crypto.js";
import { DatabaseFence } from "./database-fence.js";
import { employeeRows, employeeTime } from "./employee-records.js";
import { hasIntegerTokens } from "./json-input.js";
import { refuse } from "./owner-transaction.js";
import { ProductJson } from "./product-response.js";
import type { ProductRoute } from "./product-identity.js";

const secretDigest = (kind: string, value: string) => digest(`openbot:${kind}:${value}`);
async function event(
  db: postgres.TransactionSql,
  nodeId: string,
  kind: string,
  details: postgres.JSONValue,
  stamp: Date,
) {
  await db`INSERT INTO node_identity_events(id,node_id,type,details,created_at) VALUES(${randomUUID()},${nodeId},${kind},${db.json(details)},${stamp})`;
  await db`INSERT INTO run_events(id,type,payload,created_at) VALUES(${randomUUID()},${"WORKER_HOST_" + kind.toUpperCase()},${db.json({ nodeId })},${stamp})`;
}
export class WorkerIdentities {
  private readonly pool: ReturnType<typeof databasePool>;
  readonly fence: DatabaseFence;
  private readonly db;
  private readonly admit = boundedAdmission(4, { waitForSettlement: true, committedResult: true });
  constructor(databaseUrl: string) {
    this.fence = new DatabaseFence(databaseUrl, LOCK_NAMESPACE.workerIdentity, 10000, "node_identity_busy");
    this.pool = databasePool(databaseUrl);
    this.db = this.pool.sql;
  }
  async trusted<T>(
    signal: AbortSignal,
    operation: (db: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return this.admit(
      signal,
      async (check) =>
        (await this.db.begin(async (db) => {
          check();
          const value = await operation(db);
          check();
          return value;
        })) as T,
    );
  }
  async authenticate(nodeId: string, credential: string, signal: AbortSignal) {
    const credentialDigest = secretDigest("credential", credential);
    return this.trusted(signal, async (db) => {
      const rows =
        await db`UPDATE node_credentials SET last_authenticated_at=date_trunc('milliseconds',clock_timestamp()),
        updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE node_id=${nodeId}
        AND credential_digest=${credentialDigest} AND revoked_at IS NULL RETURNING node_id`;
      return rows.length === 1 ? credentialDigest : null;
    });
  }
  async connectionEvent(nodeId: string, kind: "connected" | "disconnected", signal: AbortSignal) {
    await this.trusted(signal, async (db) => {
      await db`INSERT INTO run_events(id,type,payload,created_at) VALUES(${randomUUID()},
        ${"WORKER_HOST_" + kind.toUpperCase()},${db.json({ nodeId })},date_trunc('milliseconds',clock_timestamp()))`;
    });
  }
  async close() {
    await this.fence.close();
    await this.pool.close();
  }
  async reserve(client: string, signal: AbortSignal) {
    return this.trusted(signal, async (db) => {
      await db`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE.requestThrottle},hashtext(${"node-enrollment:" + client}))`;
      const [time] = await db`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
      const stamp = time!.now as Date;
      await db`DELETE FROM request_throttle_buckets WHERE updated_at<${new Date(stamp.getTime() - 600000)}`;
      const [prior] =
        await db`SELECT attempt_count,window_started_at,blocked_until FROM request_throttle_buckets WHERE scope='node-enrollment' AND client_digest=${client}`;
      if (prior?.blocked_until && prior.blocked_until > stamp)
        return Math.ceil((prior.blocked_until.getTime() - stamp.getTime()) / 1000);
      const expired = !prior || stamp.getTime() - prior.window_started_at.getTime() >= 300000,
        count = expired ? 1 : prior.attempt_count + 1;
      await db`INSERT INTO request_throttle_buckets(scope,client_digest,attempt_count,window_started_at,blocked_until,updated_at) VALUES('node-enrollment',${client},${count},${expired ? stamp : prior!.window_started_at},${count >= 30 ? new Date(stamp.getTime() + 300000) : null},${stamp}) ON CONFLICT(scope,client_digest) DO UPDATE SET attempt_count=EXCLUDED.attempt_count,window_started_at=EXCLUDED.window_started_at,blocked_until=EXCLUDED.blocked_until,updated_at=EXCLUDED.updated_at`;
      return 0;
    });
  }
}
export function nodeRoutes(service: WorkerIdentities): ProductRoute[] {
  const required = async () => {
    throw new Error("Live runtime required.");
  };
  return [
    {
      method: "GET",
      path: "/api/v1/nodes",
      kind: "product",
      execute: required,
      remote: async (owner, _ids, _body, signal, request) => {
        const live = await request.runtime!.snapshot(signal);
        return owner(async () => ({ nodes: live.nodes }));
      },
    },
    {
      method: "GET",
      path: "/api/v1/node-identities",
      kind: "product",
      execute: required,
      remote: async (owner, _ids, _body, signal, request) => {
        const live = await request.runtime!.snapshot(signal),
          nodes = new Map(live.nodes.map((node) => [node.id, node]));
        return owner(async (db) => {
          const rows = await employeeRows(
            db,
            "SELECT node_id,enrolled_at,last_authenticated_at,revoked_at FROM node_credentials ORDER BY updated_at DESC LIMIT 4097",
          );
          if (rows.length > 4096) return refuse(503, "node_identity_projection_limit");
          return nodeIdentitiesResponseSchema.parse({
            identities: rows.map((row) => ({
              nodeId: row.node_id,
              status: row.revoked_at ? "revoked" : "active",
              connected: nodes.has(row.node_id),
              enrolledAt: employeeTime(row.enrolled_at),
              ...(row.last_authenticated_at
                ? { lastAuthenticatedAt: employeeTime(row.last_authenticated_at) }
                : {}),
              ...(row.revoked_at ? { revokedAt: employeeTime(row.revoked_at) } : {}),
              ...(nodes.has(row.node_id) ? { node: nodes.get(row.node_id) } : {}),
            })),
          });
        });
      },
    },
    {
      method: "POST",
      path: "/api/v1/nodes/enrollment-tokens",
      kind: "typed",
      status: 201,
      maxBytes: 8192,
      error: "node_identity_storage_unavailable",
      execute: async (db, _ids, body) => {
        const result = createNodeEnrollmentTokenInputSchema.safeParse(body);
        if (!result.success || !hasIntegerTokens(body, ["expiresInSeconds"]))
          return refuse(422, "Invalid node identity input.");
        const value = result.data,
          secret = "obenr_" + randomBytes(32).toString("base64url");
        await db`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE.nodeEnrollment},hashtext(${value.nodeId}))`;
        const [time] = await db`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
        const stamp = time!.now as Date,
          expires = new Date(stamp.getTime() + value.expiresInSeconds * 1000);
        await db`UPDATE node_enrollment_tokens SET consumed_at=${stamp} WHERE node_id=${value.nodeId} AND consumed_at IS NULL`;
        await db`INSERT INTO node_enrollment_tokens(id,node_id,token_digest,expires_at,created_at) VALUES(${randomUUID()},${value.nodeId},${secretDigest("enrollment", secret)},${expires},${stamp})`;
        await event(
          db,
          value.nodeId,
          "enrollment_created",
          { expiresAt: expires.toISOString() },
          stamp,
        );
        return { nodeId: value.nodeId, token: secret, expiresAt: expires.toISOString() };
      },
    },
    {
      method: "POST",
      path: "/api/v1/nodes/enroll",
      kind: "typed",
      owner: false,
      status: 201,
      maxBytes: 8192,
      error: "node_identity_storage_unavailable",
      execute: required,
      remote: async (_owner, _ids, body, signal, request) => {
        const parsed = exchangeNodeEnrollmentInputSchema.safeParse(body);
        if (!parsed.success) return refuse(422, "Invalid node identity input.");
        const value = parsed.data,
          client = clientDigest(request.peer),
          retry = await service.reserve(client, signal);
        if (retry)
          return new ProductJson(
            { error: "Too many node enrollment attempts. Try again later." },
            429,
            { "Retry-After": String(retry) },
          );
        return service.fence.run(value.nodeId, signal, async (bound) => {
          const valid = await service.trusted(
            bound,
            async (db) =>
              (
                await db`SELECT id FROM node_enrollment_tokens WHERE node_id=${value.nodeId} AND token_digest=${secretDigest("enrollment", value.token)} AND consumed_at IS NULL AND expires_at>clock_timestamp()`
              ).length === 1,
          );
          if (!valid) return refuse(401, "Node enrollment token is invalid or expired.");
          // Detach before committing replacement identity, under the handshake's shared fence.
          // Failure may disconnect an old peer but cannot leave a usable revoked credential.
          await request.runtime!.detach(value.nodeId, value.token, bound);
          const credential = "obn_" + randomBytes(32).toString("base64url");
          return service.trusted(bound, async (db) => {
            const [time] = await db`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
            const stamp = time!.now as Date;
            if (
              !(
                await db`UPDATE node_enrollment_tokens SET consumed_at=${stamp} WHERE node_id=${value.nodeId} AND token_digest=${secretDigest("enrollment", value.token)} AND consumed_at IS NULL AND expires_at>${stamp} RETURNING id`
              ).length
            )
              return refuse(401, "Node enrollment token is invalid or expired.");
            await db`INSERT INTO node_credentials(node_id,credential_digest,enrolled_at,updated_at) VALUES(${value.nodeId},${secretDigest("credential", credential)},${stamp},${stamp}) ON CONFLICT(node_id) DO UPDATE SET credential_digest=EXCLUDED.credential_digest,enrolled_at=EXCLUDED.enrolled_at,last_authenticated_at=NULL,revoked_at=NULL,updated_at=EXCLUDED.updated_at`;
            await event(
              db,
              value.nodeId,
              "enrolled",
              { clientIdentityDigest: client, clientIdentitySource: "direct" },
              stamp,
            );
            await db`DELETE FROM request_throttle_buckets WHERE scope='node-enrollment' AND client_digest=${client}`;
            return {
              format: "openbot.node-identity/v1",
              nodeId: value.nodeId,
              credential,
              enrolledAt: stamp.toISOString(),
            };
          });
        });
      },
    },
    {
      method: "POST",
      path: "/api/v1/nodes/{node_id}/revoke",
      kind: "product",
      status: 204,
      maxBytes: 0,
      error: "node_identity_storage_unavailable",
      execute: required,
      remote: async (owner, ids, _body, signal, request) => {
        const id = nodeIdSchema.safeParse(ids[0]);
        if (!id.success) return refuse(422, "Node id is invalid.");
        return service.fence.run(id.data, signal, async (bound) => {
          await owner(async (db) => {
            if (
              !(
                await db`SELECT node_id FROM node_credentials WHERE node_id=${id.data} AND revoked_at IS NULL`
              ).length
            )
              return refuse(404, "Active Node identity not found.");
          }, bound);
          await request.runtime!.detach(id.data, undefined, bound);
          await owner(async (db) => {
            const [time] = await db`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
            const stamp = time!.now as Date;
            if (
              !(
                await db`UPDATE node_credentials SET revoked_at=${stamp},updated_at=${stamp} WHERE node_id=${id.data} AND revoked_at IS NULL RETURNING node_id`
              ).length
            )
              return refuse(404, "Active Node identity not found.");
            await event(db, id.data, "revoked", {}, stamp);
          }, bound);
        });
      },
    },
  ];
}
