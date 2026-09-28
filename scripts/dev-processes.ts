import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_TERMINATION_GRACE_MS = 12_000;
export type DevProcessOwnerOptions = {
  readonly cwd: string;
  readonly graceMs?: number;
  readonly createChild?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
  ) => ChildProcess;
};
type ExitOutcome = {
  readonly kind: "exit";
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};
type ErrorOutcome = { readonly kind: "error"; readonly error: Error };
type ProcessOutcome = ExitOutcome | ErrorOutcome;
type TrackedChild = {
  readonly child: ChildProcess;
  readonly completion: Promise<ProcessOutcome>;
  settle: ((outcome: ProcessOutcome) => void) | undefined;
};
/**
 * Owns every child started for `dev-python` startup.
 * One stop wave; spawn error settles like exit; no new starts after stop.
 */
export class DevProcessOwner {
  readonly #cwd: string;
  readonly #graceMs: number;
  readonly #createChild: NonNullable<DevProcessOwnerOptions["createChild"]>;
  readonly #records = new Map<ChildProcess, TrackedChild>();
  readonly #alive = new Set<TrackedChild>();
  #stopping = false;
  #stopWave: Promise<void> | undefined;
  constructor(options: DevProcessOwnerOptions) {
    this.#cwd = options.cwd;
    this.#graceMs = options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.#createChild = options.createChild ?? spawn;
  }
  get stopping(): boolean {
    return this.#stopping;
  }
  start(command: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
    if (this.#stopping) {
      throw new Error("Development process owner has stopped.");
    }
    const child = this.#createChild(command, [...args], {
      cwd: this.#cwd,
      env,
      stdio: "inherit",
    });
    let settle: ((outcome: ProcessOutcome) => void) | undefined;
    const completion = new Promise<ProcessOutcome>((resolve) => {
      settle = resolve;
    });
    const tracked: TrackedChild = { child, completion, settle };
    this.#records.set(child, tracked);
    this.#alive.add(tracked);
    const releaseExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (tracked.settle === undefined) return;
      const finish = tracked.settle;
      tracked.settle = undefined;
      this.#alive.delete(tracked);
      finish({ kind: "exit", code, signal });
    };
    const releaseSpawnError = (error: Error): void => {
      if (tracked.settle === undefined) return;
      if (child.pid !== undefined) return;
      const finish = tracked.settle;
      tracked.settle = undefined;
      this.#alive.delete(tracked);
      finish({ kind: "error", error });
    };
    child.once("exit", (code, signal) => {
      releaseExit(code, signal);
    });
    child.once("error", (error) => {
      releaseSpawnError(error);
    });
    return child;
  }
  waitSuccess(child: ChildProcess): Promise<void> {
    const tracked = this.#records.get(child);
    if (tracked === undefined) {
      return Promise.reject(new Error("Development process is not owned by this owner."));
    }
    return tracked.completion.then((outcome) => {
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.code === 0) return;
      throw new Error(`Development process exited (${outcome.signal ?? outcome.code}).`);
    });
  }
  stop(): Promise<void> {
    this.#stopping = true;
    if (this.#stopWave !== undefined) return this.#stopWave;
    this.#stopWave = this.#runStopWave();
    return this.#stopWave;
  }
  async #runStopWave(): Promise<void> {
    const snapshot = [...this.#alive];
    const results = await Promise.allSettled(snapshot.map((tracked) => this.#terminate(tracked)));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 0) return;
    const first = failures[0];
    const error = first instanceof Error ? first : new Error("Development process stop failed.");
    if (failures.length > 1) {
      throw new AggregateError(failures, error.message);
    }
    throw error;
  }
  async #terminate(tracked: TrackedChild): Promise<void> {
    const { child, completion } = tracked;
    // A failed spawn exposes its error asynchronously but never owns a PID to signal.
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      await completion;
      return;
    }
    try {
      this.#deliverSignal(child, "SIGTERM");
    } catch (error) {
      if (await this.#settledSoon(completion)) return;
      throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const beforeKill = await Promise.race([
        completion.then(() => "done" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), this.#graceMs);
        }),
      ]);
      if (beforeKill === "done") return;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    try {
      this.#deliverSignal(child, "SIGKILL");
    } catch (error) {
      if (await this.#settledSoon(completion)) return;
      throw error;
    }
    await completion;
  }
  #deliverSignal(child: ChildProcess, signal: NodeJS.Signals): void {
    let delivered: boolean;
    try {
      delivered = child.kill(signal);
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      throw error instanceof Error ? error : new Error(`Development process ${signal} failed.`);
    }
    if (delivered) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    throw new Error(`Development process ${signal} was not delivered.`);
  }
  async #settledSoon(completion: Promise<ProcessOutcome>): Promise<boolean> {
    return await Promise.race([
      completion.then(() => true),
      new Promise<boolean>((resolve) => {
        setImmediate(() => resolve(false));
      }),
    ]);
  }
}
