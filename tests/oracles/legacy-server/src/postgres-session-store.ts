import { authSessions } from "@openbot/db";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type {
  CreateOwnerSessionInput,
  OwnerSessionStore,
  StoredOwnerSession,
} from "./session-store.js";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];

export class PostgresOwnerSessionStore implements OwnerSessionStore {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  async createSession(input: CreateOwnerSessionInput): Promise<StoredOwnerSession> {
    await this.#db.delete(authSessions).where(lte(authSessions.expiresAt, input.createdAt));

    const rows = await this.#db
      .insert(authSessions)
      .values({
        id: input.id,
        ownerId: input.ownerId,
        tokenDigest: input.tokenDigest,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      })
      .returning();

    const session = rows[0];
    if (session === undefined) throw new Error("Session was not persisted.");
    return toStoredSession(session);
  }

  async findActiveSession(tokenDigest: string, now: Date): Promise<StoredOwnerSession | undefined> {
    const rows = await this.#db
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.tokenDigest, tokenDigest),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? undefined : toStoredSession(rows[0]);
  }

  async revokeSession(tokenDigest: string, now: Date): Promise<void> {
    await this.#db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(and(eq(authSessions.tokenDigest, tokenDigest), isNull(authSessions.revokedAt)));
  }
}

function toStoredSession(row: typeof authSessions.$inferSelect): StoredOwnerSession {
  return {
    id: row.id,
    ownerId: "owner",
    tokenDigest: row.tokenDigest,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}
