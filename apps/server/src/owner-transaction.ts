/** Runs Owner-authorized transactions with final expiry checks and bounded admission. */
import { sessionDigest, requireOwnerSession } from "./owner-session.js";
import { databasePool } from "./database-pool.js";
import postgres from "postgres";
import { boundedAdmission } from "./request-limits.js";
import { HttpFailure } from "./http-errors.js";

export const refuse = (status: number, error: string): never => {
  throw new HttpFailure(status, { error });
};
export function ownerTransactions(databaseUrl: string, limit = 16) {
  const pool = databasePool(databaseUrl);
  const sql = pool.sql;
  // One page now uses this pool for the complete product surface. Keep four actual SQL
  // transactions and at most twelve queued requests inside the same six-second deadline.
  // Immediate refusal at four rejected normal workspace/reaction refresh bursts.
  const admit = boundedAdmission(limit, { waitForSettlement: true, committedResult: true });
  async function run<T>(
    token: string | undefined,
    signal: AbortSignal,
    operation: (db: postgres.TransactionSql, check: () => void) => Promise<T>,
    lock = true,
    isolation: "read committed" | "repeatable read" = "read committed",
  ): Promise<T> {
    const hash = sessionDigest(token);
    return admit(signal, async (check) => {
      const result = await sql.begin("isolation level " + isolation, async (db) => {
        const authorize = async (locked: boolean) => {
          await requireOwnerSession(db, hash, locked);
          check();
        };
        await authorize(lock);
        const value = await operation(db, check);
        // SHARE protects revocation while expiry is checked again immediately before commit.
        await authorize(false);
        return value;
      });
      return result as T;
    });
  }
  return {
    run,
    preflight: (token: string | undefined, signal: AbortSignal) =>
      run(token, signal, async () => undefined, false),
    verify: async (initialize?: (db: postgres.TransactionSql) => Promise<void>) => {
      await sql`SELECT id,token_digest,owner_id,revoked_at,expires_at FROM auth_sessions LIMIT 0`;
      if (initialize) await sql.begin(async (db) => initialize(db));
    },
    close: () => pool.close(),
  };
}
