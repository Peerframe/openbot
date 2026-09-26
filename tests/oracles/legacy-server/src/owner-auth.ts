import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthSessionSnapshot, OwnerIdentity } from "@openbot/domain";
import type { RequestThrottle } from "./request-throttle.js";
import type { OwnerSessionStore } from "./session-store.js";

export interface OwnerAuthOptions {
  ownerName: string;
  ownerPassword: string;
  sessionTtlMs: number;
}

export class InvalidCredentialsError extends Error {}

export class LoginRateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many login attempts. Try again later.");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class OwnerAuthService {
  readonly #store: OwnerSessionStore;
  readonly #owner: OwnerIdentity;
  readonly #password: string;
  readonly #sessionTtlMs: number;
  readonly #throttle: RequestThrottle;

  constructor(store: OwnerSessionStore, options: OwnerAuthOptions, throttle: RequestThrottle) {
    this.#store = store;
    this.#owner = { id: "owner", name: options.ownerName };
    this.#password = options.ownerPassword;
    this.#sessionTtlMs = options.sessionTtlMs;
    this.#throttle = throttle;
  }

  async login(
    password: string,
    clientIdentityDigest: string,
  ): Promise<{ token: string; session: AuthSessionSnapshot & { authenticated: true } }> {
    const now = new Date();
    const reservation = await this.#throttle.reserve("owner-login", clientIdentityDigest);
    if (!reservation.allowed) {
      throw new LoginRateLimitedError(reservation.retryAfterSeconds);
    }
    if (!constantTimeEqual(password, this.#password)) {
      throw new InvalidCredentialsError("Invalid owner password.");
    }

    await this.#throttle.clear("owner-login", clientIdentityDigest);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + this.#sessionTtlMs);
    await this.#store.createSession({
      id: randomUUID(),
      ownerId: "owner",
      tokenDigest: digestToken(token),
      expiresAt,
      createdAt: now,
    });
    return {
      token,
      session: {
        authenticated: true,
        owner: this.#owner,
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  async authenticate(token: string | undefined): Promise<AuthSessionSnapshot> {
    if (token === undefined || token.length === 0) return { authenticated: false };
    const session = await this.#store.findActiveSession(digestToken(token), new Date());
    if (session === undefined) return { authenticated: false };
    return {
      authenticated: true,
      owner: this.#owner,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  async logout(token: string | undefined): Promise<void> {
    if (token === undefined || token.length === 0) return;
    await this.#store.revokeSession(digestToken(token), new Date());
  }
}

function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeEqual(value: string, expected: string): boolean {
  const valueDigest = createHash("sha256").update(value).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(valueDigest, expectedDigest);
}
