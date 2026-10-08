import postgres from "postgres";
import { boundedAdmission, digest } from "./owner-auth-crypto.js";
import { WriteFailure } from "./primary-bot-write.js";

export const refuse = (status: number, error: string): never => {
  throw new WriteFailure(status, { error });
};
export function ownerTransactions(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 4,
    connect_timeout: 3,
    onnotice: () => undefined,
    connection: {
      application_name: "openbot-ts-product",
      statement_timeout: 3000,
      lock_timeout: 1000,
      idle_in_transaction_session_timeout: 5000,
      search_path: "public,pg_catalog",
      timezone: "UTC",
    },
  });
  const admit = boundedAdmission(4, true);
  async function run<T>(
    token: string | undefined,
    signal: AbortSignal,
    operation: (db: postgres.TransactionSql) => Promise<T>,
    lock = true,
    isolation: "read committed" | "repeatable read" = "read committed",
  ): Promise<T> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) refuse(401, "Authentication required.");
    const hash = digest(token!);
    return admit(signal, async (check) => {
      const result = await sql.begin("isolation level " + isolation, async (db) => {
        const authorize = async (locked: boolean) => {
          const rows = await db.unsafe(
            "SELECT id FROM auth_sessions WHERE token_digest=$1 AND owner_id='owner' " +
              "AND revoked_at IS NULL AND expires_at > clock_timestamp()" +
              (locked ? " FOR SHARE" : ""),
            [hash],
          );
          if (!rows.length) refuse(401, "Authentication required.");
          check();
        };
        await authorize(lock);
        const value = await operation(db);
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
    close: () => sql.end({ timeout: 1 }),
  };
}
