import postgres from "postgres";
import { refuse } from "./owner-transaction.js";

/** Shared with retained Worker/Agent gates. One dedicated connection spans short transactions
 * and transport; closing it releases the session lock even after cancellation or an exception. */
export class DatabaseFence {
  private active = 0;
  private readonly stop = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly databaseUrl: string,
    private readonly namespace: number,
    private readonly milliseconds: number,
    private readonly conflict: string,
  ) {}
  async run<T>(
    key: string,
    signal: AbortSignal,
    operation: (signal: AbortSignal, backendPid: number) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 16 || signal.aborted || this.stop.signal.aborted)
      return refuse(this.namespace === 1326850642 ? 409 : 503, this.conflict);
    this.active++;
    const lost = new AbortController();
    const bounded = AbortSignal.any([
      lost.signal,
      signal,
      this.stop.signal,
      AbortSignal.timeout(this.milliseconds),
    ]);
    const db = postgres(this.databaseUrl, {
      max: 1,
      connect_timeout: 3,
      idle_timeout: 0,
      max_lifetime: 0,
      onnotice: () => undefined,
      onclose: () => lost.abort(),
      connection: {
        application_name: "openbot-ts-runtime-fence",
        statement_timeout: 3000,
        lock_timeout: 1000,
      },
    });
    const work = (async () => {
      try {
        const [lock] =
          this.namespace === 1326850643
            ? await db`SELECT pg_advisory_lock(${this.namespace},hashtext(${key})),true AS held,pg_backend_pid() AS pid`
            : await db`SELECT pg_try_advisory_lock(${this.namespace},hashtext(${key})) AS held,pg_backend_pid() AS pid`;
        if (!lock?.held) return refuse(409, this.conflict);
        bounded.throwIfAborted();
        const result = await operation(bounded, Number(lock.pid));
        bounded.throwIfAborted();
        return result;
      } finally {
        await db.end({ timeout: 1 });
        this.active--;
      }
    })();
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
    }
  }
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.pending]);
  }
}
