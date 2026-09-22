import type { WorkspaceSnapshot } from "@openbot/domain";

type Waiter = (error: Error | undefined, snapshot?: WorkspaceSnapshot) => void;
type PendingRead = { started: boolean; expired: boolean; waiters: Set<Waiter> };

/**
 * Postgres.js callback transactions cannot cancel pool acquisition. Keep at most one
 * actual read alive, even after a caller times out. New callers arriving after its
 * query starts wait for the next read, so a GET cannot join a pre-mutation snapshot.
 */
export class WorkspaceSnapshotReader {
  #pending: PendingRead | undefined;
  readonly #queued = new Set<Waiter>();
  readonly #read: () => Promise<WorkspaceSnapshot>;

  constructor(read: () => Promise<WorkspaceSnapshot>) {
    this.#read = read;
  }

  read(signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    if (signal?.aborted) return Promise.reject(new Error("workspace_snapshot_cancelled"));
    if (this.#pending?.expired || (this.#pending?.waiters.size ?? 0) + this.#queued.size >= 32) {
      return Promise.reject(new Error("workspace_snapshot_busy"));
    }
    const pending = this.#pending;
    const waiters = pending && !pending.started ? pending.waiters : this.#queued;
    const result = new Promise<WorkspaceSnapshot>((resolve, reject) => {
      const finish: Waiter = (error, snapshot) => {
        // A queued waiter can move into the current read while its deadline runs.
        this.#queued.delete(finish);
        this.#pending?.waiters.delete(finish);
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancel);
        if (error || !snapshot) reject(error ?? new Error("workspace_snapshot_unavailable"));
        else resolve(snapshot);
      };
      const cancel = () => finish(new Error("workspace_snapshot_cancelled"));
      const deadline = setTimeout(() => finish(new Error("workspace_snapshot_timeout")), 10_000);
      waiters.add(finish);
      signal?.addEventListener("abort", cancel, { once: true });
    });
    this.#start();
    return result;
  }

  #start(): void {
    if (this.#pending || this.#queued.size === 0) return;
    const pending: PendingRead = { started: false, expired: false, waiters: new Set(this.#queued) };
    this.#queued.clear();
    this.#pending = pending;
    const deadline = setTimeout(() => {
      pending.expired = true;
      for (const finish of [...pending.waiters, ...this.#queued])
        finish(new Error("workspace_snapshot_timeout"));
    }, 10_000);
    void Promise.resolve()
      .then(() => {
        pending.started = true;
        return this.#read();
      })
      .then(
        (snapshot) => {
          for (const finish of [...pending.waiters]) finish(undefined, snapshot);
        },
        () => {
          for (const finish of [...pending.waiters])
            finish(new Error("workspace_snapshot_unavailable"));
        },
      )
      .finally(() => {
        clearTimeout(deadline);
        this.#pending = undefined;
        this.#start();
      });
  }
}
