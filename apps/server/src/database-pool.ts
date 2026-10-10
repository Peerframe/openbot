/** Owns shared bounded SQL pools; long advisory gates never occupy ordinary transaction slots. */
import postgres from "postgres";
import { reportFailure } from "./logging.js";

type PoolKind = "transactions" | "fences";
type Pool = {
  sql: postgres.Sql; references: number; disconnected: Set<() => void>;
  failed: boolean; closing: boolean; retirement?: Promise<void>;
};
const pools = new Map<string, Map<PoolKind, Pool>>();

export function databasePool(databaseUrl: string, kind: PoolKind = "transactions") {
  let kinds = pools.get(databaseUrl);
  if (!kinds) {
    kinds = new Map();
    pools.set(databaseUrl, kinds);
  }
  let pool = kinds.get(kind);
  if (!pool || pool.failed) {
    const disconnected = new Set<() => void>();
    const sql = postgres(databaseUrl, {
      max: 4,
      connect_timeout: 3,
      ...(kind === "fences" ? { idle_timeout: 0, max_lifetime: 0 } : {}),
      onnotice: () => undefined,
      onclose: () => {
        if (kind === "fences" && pool && !pool.closing)
          void retire(pool).catch((error) => reportFailure("database-fence-retirement", error));
        for (const notify of disconnected) notify();
      },
      connection: {
        application_name: `openbot-${kind}`,
        statement_timeout: 3000,
        lock_timeout: 1000,
        idle_in_transaction_session_timeout: kind === "fences" ? 45000 : 5000,
        search_path: "public,pg_catalog",
        timezone: "UTC",
      },
    });
    pool = { sql, references: 0, disconnected, failed: false, closing: false };
    kinds.set(kind, pool);
  }
  function retire(value: Pool): Promise<void> {
    if (value.retirement) return value.retirement;
    value.failed = true;
    value.closing = true;
    for (const notify of value.disconnected) notify();
    value.retirement = value.sql.end({ timeout: 0 });
    return value.retirement;
  }
  const owned = pool;
  owned.references++;
  let closed = false;
  return {
    sql: owned.sql,
    disconnected: owned.disconnected,
    get failed() { return owned.failed; },
    retire: () => retire(owned),
    async close() {
      if (closed) return;
      closed = true;
      if (--owned.references > 0) {
        if (owned.failed) await owned.retirement;
        return;
      }
      if (kinds.get(kind) === owned) kinds.delete(kind);
      if (!kinds.size) pools.delete(databaseUrl);
      owned.closing = true;
      await (owned.retirement ?? owned.sql.end({ timeout: 1 }));
    },
  };
}

/** LISTEN has one dedicated socket: reconnecting silently could lose committed invalidations. */
export function notificationConnection(databaseUrl: string,
  onnotify: (channel: string, payload: string) => void, onclose: () => void) {
  const options: postgres.Options<{}> & { onnotify: typeof onnotify } = {
    max: 1, idle_timeout: 0, max_lifetime: 0, connect_timeout: 3, fetch_types: false,
    connection: { application_name: "openbot-events", statement_timeout: 3000 },
    onnotify, onclose, onnotice: () => undefined,
  };
  return postgres(databaseUrl, options);
}
