import { requestThrottleBuckets } from "@openbot/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type {
  RequestAttemptReservation,
  RequestThrottleScope,
  RequestThrottleStore,
  ReserveRequestAttemptInput,
} from "./request-throttle.js";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];
const requestThrottleLockNamespace = 1_745_083_476;

export class PostgresRequestThrottleStore implements RequestThrottleStore {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  reserveAttempt(input: ReserveRequestAttemptInput): Promise<RequestAttemptReservation> {
    return this.#db.transaction(async (transaction) => {
      const lockKey = `${input.scope}:${input.clientDigest}`;
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${requestThrottleLockNamespace}, hashtext(${lockKey}))`,
      );
      const retentionBefore = new Date(
        input.now.getTime() - Math.max(input.windowMs, input.blockMs) * 2,
      );
      await transaction
        .delete(requestThrottleBuckets)
        .where(lt(requestThrottleBuckets.updatedAt, retentionBefore));
      const [current] = await transaction
        .select()
        .from(requestThrottleBuckets)
        .where(
          and(
            eq(requestThrottleBuckets.scope, input.scope),
            eq(requestThrottleBuckets.clientDigest, input.clientDigest),
          ),
        )
        .limit(1);

      if (current?.blockedUntil !== null && current?.blockedUntil !== undefined) {
        const remainingMs = current.blockedUntil.getTime() - input.now.getTime();
        if (remainingMs > 0) {
          return { allowed: false, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
        }
      }

      const windowExpired =
        current === undefined ||
        input.now.getTime() - current.windowStartedAt.getTime() >= input.windowMs;
      const attemptCount = windowExpired ? 1 : current.attemptCount + 1;
      const windowStartedAt = windowExpired ? input.now : current.windowStartedAt;
      const blockedUntil =
        attemptCount >= input.maximumAttempts
          ? new Date(input.now.getTime() + input.blockMs)
          : null;

      await transaction
        .insert(requestThrottleBuckets)
        .values({
          scope: input.scope,
          clientDigest: input.clientDigest,
          attemptCount,
          windowStartedAt,
          blockedUntil,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [requestThrottleBuckets.scope, requestThrottleBuckets.clientDigest],
          set: { attemptCount, windowStartedAt, blockedUntil, updatedAt: input.now },
        });
      return { allowed: true };
    });
  }

  async clearAttempts(scope: RequestThrottleScope, clientDigest: string): Promise<void> {
    await this.#db
      .delete(requestThrottleBuckets)
      .where(
        and(
          eq(requestThrottleBuckets.scope, scope),
          eq(requestThrottleBuckets.clientDigest, clientDigest),
        ),
      );
  }
}
