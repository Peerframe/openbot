import type { SubmitTaskResult } from "@openbot/domain";

import type { Automation, CreateAutomationInput } from "@openbot/protocol";

export {
  type Automation,
  type AutomationOutcome,
  type CreateAutomationInput,
  createAutomationInputSchema,
  updateAutomationInputSchema,
} from "@openbot/protocol";
export interface AutomationStore {
  list(): Promise<Automation[]>;
  create(input: CreateAutomationInput): Promise<Automation>;
  setEnabled(id: string, enabled: boolean): Promise<Automation>;
  delete(id: string): Promise<void>;
  submitDue(): Promise<SubmitTaskResult[]>;
}

/** Advance straight past downtime without replaying a backlog of missed occurrences. */
export function nextIntervalOccurrence(previous: Date, minutes: number, now: Date): Date {
  const interval = minutes * 60_000;
  if (
    !Number.isInteger(minutes) ||
    minutes < 15 ||
    minutes > 10080 ||
    !Number.isFinite(previous.getTime()) ||
    !Number.isFinite(now.getTime())
  ) {
    throw new Error("Invalid interval occurrence.");
  }
  if (previous > now) return previous;
  return new Date(
    previous.getTime() +
      (Math.floor((now.getTime() - previous.getTime()) / interval) + 1) * interval,
  );
}

export class AutomationScheduler {
  readonly #store: Pick<AutomationStore, "submitDue">;
  readonly #publish: (result: SubmitTaskResult) => void;
  readonly #onError: () => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<void> | undefined;
  #stopped = true;
  constructor(
    store: Pick<AutomationStore, "submitDue">,
    publish: (result: SubmitTaskResult) => void,
    onError: () => void,
  ) {
    this.#store = store;
    this.#publish = publish;
    this.#onError = onError;
  }
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.tick();
    }, 15_000);
    this.#timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#pending) return this.#pending;
    this.#pending = this.#store
      .submitDue()
      .then((results) => {
        if (!this.#stopped) for (const result of results) this.#publish(result);
      })
      .catch(() => this.#onError())
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }
  async stop(): Promise<boolean> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (!this.#pending) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A pooled database connection can stall before transaction timeouts take effect.
      // Committed Runs remain durable and recover through dispatcher startup after a forced drain.
      return await Promise.race([
        this.#pending.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
