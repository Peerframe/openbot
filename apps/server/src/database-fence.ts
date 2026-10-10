/** Holds advisory gates on a bounded shared pool, separate from the transactions they authorize. */
import type postgres from "postgres";
import { databasePool } from "./database-pool.js";
import { LOCK_NAMESPACE } from "./database-locks.js";
import { refuse } from "./owner-transaction.js";

export class DatabaseFence {
  private active = 0;
  private readonly stop = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private recovery: Promise<void> | undefined;
  private pool: ReturnType<typeof databasePool>;
  constructor(
    private readonly databaseUrl: string,
    private readonly namespace: number,
    private readonly milliseconds: number,
    private readonly conflict: string,
  ) {
    this.pool = databasePool(databaseUrl, "fences");
  }
  async run<T>(
    key: string,
    signal: AbortSignal,
    operation: (signal: AbortSignal, backendPid: number) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 16 || signal.aborted || this.stop.signal.aborted)
      return refuse(this.namespace === LOCK_NAMESPACE.browser ? 409 : 503, this.conflict);
    this.active++;
    const work = this.perform(key, signal, operation);
    this.pending.add(work);
    try {
      return await work as T;
    } finally {
      this.pending.delete(work);
      this.active--;
    }
  }
  private async perform<T>(key: string, signal: AbortSignal,
    operation: (signal: AbortSignal, backendPid: number) => Promise<T>): Promise<T> {
    if (this.pool.failed) {
      this.recovery ??= this.pool.close().then(() => {
        this.pool = databasePool(this.databaseUrl, "fences");
      }).finally(() => { this.recovery = undefined; });
      await this.recovery;
    }
    const pool = this.pool;
    const lost = new AbortController();
    const disconnected = () => lost.abort();
    pool.disconnected.add(disconnected);
    const bounded = AbortSignal.any([
      lost.signal, signal, this.stop.signal, AbortSignal.timeout(this.milliseconds),
    ]);
    let db: postgres.ReservedSql | undefined;
    let held = false;
    try {
      bounded.throwIfAborted();
      db = await pool.sql.reserve();
      bounded.throwIfAborted();
      const [lock] = this.namespace === LOCK_NAMESPACE.workerIdentity
        ? await db`SELECT pg_advisory_lock(${this.namespace},hashtext(${key})),true AS held,pg_backend_pid() AS pid`
        : await db`SELECT pg_try_advisory_lock(${this.namespace},hashtext(${key})) AS held,pg_backend_pid() AS pid`;
      held = Boolean(lock?.held);
      if (!held) return refuse(409, this.conflict);
      bounded.throwIfAborted();
      const result = await operation(bounded, Number(lock!.pid));
      bounded.throwIfAborted();
      return result;
    } finally {
      try {
        // A failed reserved socket must never execute another query or return to the idle queue.
        // Retiring the small lock pool also releases other affected gates before any reuse.
        if (db && held && !pool.failed) {
          try {
            const [unlocked] = await db`SELECT pg_advisory_unlock(${this.namespace},hashtext(${key})) AS released`;
            if (!unlocked?.released) await pool.retire();
          } catch {
            await pool.retire();
          }
        }
      } finally {
        pool.disconnected.delete(disconnected);
        if (!pool.failed) db?.release();
        else await pool.retire();
      }
    }
  }
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.pending]);
    await this.pool.close();
  }
}
