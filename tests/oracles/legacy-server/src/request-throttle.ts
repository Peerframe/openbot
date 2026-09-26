export type RequestThrottleScope = "owner-login" | "node-enrollment";

export interface RequestThrottlePolicy {
  maximumAttempts: number;
  windowMs: number;
  blockMs: number;
}

export interface ReserveRequestAttemptInput extends RequestThrottlePolicy {
  scope: RequestThrottleScope;
  clientDigest: string;
  now: Date;
}

export type RequestAttemptReservation =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface RequestThrottleStore {
  reserveAttempt(input: ReserveRequestAttemptInput): Promise<RequestAttemptReservation>;
  clearAttempts(scope: RequestThrottleScope, clientDigest: string): Promise<void>;
}

const policies: Record<RequestThrottleScope, RequestThrottlePolicy> = {
  "owner-login": {
    maximumAttempts: 5,
    windowMs: 5 * 60 * 1000,
    blockMs: 5 * 60 * 1000,
  },
  "node-enrollment": {
    maximumAttempts: 30,
    windowMs: 5 * 60 * 1000,
    blockMs: 5 * 60 * 1000,
  },
};

export class RequestThrottle {
  readonly #store: RequestThrottleStore;
  readonly #now: () => Date;

  constructor(store: RequestThrottleStore, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  reserve(scope: RequestThrottleScope, clientDigest: string): Promise<RequestAttemptReservation> {
    return this.#store.reserveAttempt({
      scope,
      clientDigest,
      now: this.#now(),
      ...policies[scope],
    });
  }

  clear(scope: RequestThrottleScope, clientDigest: string): Promise<void> {
    return this.#store.clearAttempts(scope, clientDigest);
  }
}
