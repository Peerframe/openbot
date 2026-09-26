import { randomUUID } from "node:crypto";
import { nodeCredentials, nodeEnrollmentTokens, nodeIdentityEvents } from "@openbot/db";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type {
  ExchangeNodeEnrollmentRecord,
  NodeIdentityStore,
  StoredNodeEnrollmentToken,
} from "./node-identity.js";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];
const nodeEnrollmentLockNamespace = 1_326_831_444;

export class PostgresNodeIdentityStore implements NodeIdentityStore {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  async replaceEnrollmentToken(record: StoredNodeEnrollmentToken): Promise<void> {
    await this.#db.transaction(async (transaction) => {
      // Serialize issuance for one Node before touching the partial unique index. The namespace
      // separates this transaction lock from migration and future application advisory locks.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${nodeEnrollmentLockNamespace}, hashtext(${record.nodeId}))`,
      );
      await transaction
        .update(nodeEnrollmentTokens)
        .set({ consumedAt: record.createdAt })
        .where(
          and(
            eq(nodeEnrollmentTokens.nodeId, record.nodeId),
            isNull(nodeEnrollmentTokens.consumedAt),
          ),
        );
      await transaction.insert(nodeEnrollmentTokens).values(record);
      await transaction.insert(nodeIdentityEvents).values({
        id: randomUUID(),
        nodeId: record.nodeId,
        type: "enrollment_created",
        details: { expiresAt: record.expiresAt.toISOString() },
        createdAt: record.createdAt,
      });
    });
  }

  async exchangeEnrollmentToken(record: ExchangeNodeEnrollmentRecord): Promise<boolean> {
    return this.#db.transaction(async (transaction) => {
      const consumed = await transaction
        .update(nodeEnrollmentTokens)
        .set({ consumedAt: record.enrolledAt })
        .where(
          and(
            eq(nodeEnrollmentTokens.nodeId, record.nodeId),
            eq(nodeEnrollmentTokens.tokenDigest, record.tokenDigest),
            isNull(nodeEnrollmentTokens.consumedAt),
            gt(nodeEnrollmentTokens.expiresAt, record.enrolledAt),
          ),
        )
        .returning({ id: nodeEnrollmentTokens.id });
      if (consumed.length === 0) return false;

      await transaction
        .insert(nodeCredentials)
        .values({
          nodeId: record.nodeId,
          credentialDigest: record.credentialDigest,
          enrolledAt: record.enrolledAt,
          updatedAt: record.enrolledAt,
        })
        .onConflictDoUpdate({
          target: nodeCredentials.nodeId,
          set: {
            credentialDigest: record.credentialDigest,
            enrolledAt: record.enrolledAt,
            lastAuthenticatedAt: null,
            revokedAt: null,
            updatedAt: record.enrolledAt,
          },
        });
      await transaction.insert(nodeIdentityEvents).values({
        id: randomUUID(),
        nodeId: record.nodeId,
        type: "enrolled",
        details: {
          clientIdentityDigest: record.clientIdentityDigest,
          clientIdentitySource: record.clientIdentitySource,
        },
        createdAt: record.enrolledAt,
      });
      return true;
    });
  }

  async authenticateCredential(
    nodeId: string,
    credentialDigest: string,
    now: Date,
  ): Promise<boolean> {
    const authenticated = await this.#db
      .update(nodeCredentials)
      .set({ lastAuthenticatedAt: now, updatedAt: now })
      .where(
        and(
          eq(nodeCredentials.nodeId, nodeId),
          eq(nodeCredentials.credentialDigest, credentialDigest),
          isNull(nodeCredentials.revokedAt),
        ),
      )
      .returning({ nodeId: nodeCredentials.nodeId });
    return authenticated.length === 1;
  }

  listCredentials() {
    return this.#db
      .select({
        nodeId: nodeCredentials.nodeId,
        enrolledAt: nodeCredentials.enrolledAt,
        lastAuthenticatedAt: nodeCredentials.lastAuthenticatedAt,
        revokedAt: nodeCredentials.revokedAt,
      })
      .from(nodeCredentials)
      .orderBy(desc(nodeCredentials.updatedAt));
  }

  async revokeCredential(nodeId: string, now: Date): Promise<boolean> {
    return this.#db.transaction(async (transaction) => {
      const revoked = await transaction
        .update(nodeCredentials)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(nodeCredentials.nodeId, nodeId), isNull(nodeCredentials.revokedAt)))
        .returning({ nodeId: nodeCredentials.nodeId });
      if (revoked.length === 0) return false;
      await transaction.insert(nodeIdentityEvents).values({
        id: randomUUID(),
        nodeId,
        type: "revoked",
        details: {},
        createdAt: now,
      });
      return true;
    });
  }
}
