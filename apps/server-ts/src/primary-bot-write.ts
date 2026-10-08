import { createHash, randomUUID } from "node:crypto";
import { workspacePrimaryBotInputSchema, workspacePrimaryBotSchema } from "@openbot/protocol";
import postgres from "postgres";
import { z } from "zod";

export class WriteFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: { error: string },
  ) {
    super("Owner write refused.");
  }
}
export const writeUnavailable = () =>
  new WriteFailure(503, { error: "Control-plane storage is unavailable." });
const unauthorized = () => new WriteFailure(401, { error: "Authentication required." });
// Python's bounded Bot identifier counts Unicode code points. Keep the shared strict
// shape and mathematical-integer revision, with that existing input compatibility adapter.
const botIdentifier = z
  .string()
  .refine((value) => [...value].length >= 1 && [...value].length <= 128)
  .nullable();
const commandSchema = workspacePrimaryBotInputSchema.extend({ botId: botIdentifier });
const projectionSchema = workspacePrimaryBotSchema.extend({ primaryBotId: botIdentifier });

export function primaryBotWriter(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 4,
    connect_timeout: 3,
    onnotice: () => undefined,
    connection: {
      application_name: "openbot-ts-primary-bot-write",
      statement_timeout: 3000,
      lock_timeout: 1000,
      idle_in_transaction_session_timeout: 5000,
      search_path: "public,pg_catalog",
      timezone: "UTC",
    },
  });
  let active = 0;
  async function authorized<T>(
    token: string | undefined,
    signal: AbortSignal,
    operation: (db: postgres.TransactionSql, check: () => void) => Promise<T>,
  ): Promise<T> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
    if (active >= 4 || signal.aborted) throw writeUnavailable();
    active++;
    const digest = createHash("sha256").update(token, "ascii").digest("hex");
    const deadline = new AbortController();
    const bounded = AbortSignal.any([signal, deadline.signal]);
    const check = () => {
      if (bounded.aborted) throw writeUnavailable();
    };
    let rejectAbort: (() => void) | undefined;
    const failure = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(writeUnavailable());
      bounded.addEventListener("abort", rejectAbort, { once: true });
    });
    const timer = setTimeout(() => deadline.abort(), 6000);
    timer.unref();
    // Retain the slot until SQL actually settles. Client abort rolls back before commit;
    // an unknown commit response is never retried or forwarded to a second writer.
    const transaction = sql
      .begin("isolation level read committed", async (db) => {
        check();
        const session = await db`SELECT token_digest FROM auth_sessions WHERE token_digest=${digest}
        AND owner_id='owner' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`;
        check();
        if (session.length !== 1) throw unauthorized();
        const result = await operation(db, check);
        const current = await db`SELECT token_digest FROM auth_sessions WHERE token_digest=${digest}
        AND owner_id='owner' AND revoked_at IS NULL AND expires_at>clock_timestamp()`;
        check();
        if (current.length !== 1) throw unauthorized();
        return result;
      })
      .finally(() => {
        active--;
      });
    try {
      const result = await Promise.race([transaction, failure]);
      check();
      return result as T;
    } catch (error) {
      throw error instanceof WriteFailure ? error : writeUnavailable();
    } finally {
      clearTimeout(timer);
      if (rejectAbort) bounded.removeEventListener("abort", rejectAbort);
    }
  }
  return {
    async verify() {
      await sql`SELECT token_digest,owner_id,revoked_at,expires_at FROM auth_sessions WHERE false`;
      await sql`SELECT workspace_id,primary_bot_id,revision FROM workspace_settings WHERE false`;
      await sql`SELECT id,deleted_at FROM bots WHERE false`;
      await sql`SELECT id,type,payload FROM run_events WHERE false`;
    },
    close: () => sql.end({ timeout: 1 }),
    // Preflight precedes body parsing, as in Python. The mutation rechecks/locks the
    // session after body collection, so a slow body never carries stale authority.
    preflight: (token: string | undefined, signal: AbortSignal) =>
      authorized(token, signal, async () => undefined),
    update(token: string | undefined, value: unknown, signal: AbortSignal) {
      return authorized(token, signal, async (db, check) => {
        const parsed = commandSchema.safeParse(value);
        if (!parsed.success) throw new WriteFailure(422, { error: "Invalid request input." });
        const command = parsed.data;
        const rows =
          await db`SELECT primary_bot_id AS "primaryBotId",revision FROM workspace_settings
          WHERE workspace_id='workspace' FOR UPDATE`;
        check();
        if (rows.length !== 1)
          throw new WriteFailure(503, { error: "workspace_settings_unavailable" });
        const previous = rows[0]!;
        if (command.expectedRevision !== previous.revision)
          throw new WriteFailure(409, { error: "workspace_revision_conflict" });
        if (command.botId !== null) {
          // Python refuses non-scalar surrogate text during SQL encoding; Node otherwise
          // substitutes U+FFFD, which could select a different persisted identifier.
          if (
            [...command.botId].some((character) => {
              const code = character.codePointAt(0)!;
              return code >= 0xd800 && code <= 0xdfff;
            })
          )
            throw writeUnavailable();
          // Workspace first, then Bot: identical to identity creation/deletion/import.
          const bots =
            await db`SELECT id FROM bots WHERE id=${command.botId} AND deleted_at IS NULL FOR SHARE`;
          check();
          if (bots.length !== 1) throw new WriteFailure(404, { error: "bot_not_found" });
        }
        if (command.botId === previous.primaryBotId) return projectionSchema.parse(previous);
        if (previous.revision === 2147483647)
          throw new WriteFailure(409, { error: "workspace_revision_exhausted" });
        const updated =
          await db`UPDATE workspace_settings SET primary_bot_id=${command.botId},revision=revision+1
          WHERE workspace_id='workspace' RETURNING primary_bot_id AS "primaryBotId",revision`;
        check();
        const result = projectionSchema.parse(updated[0]);
        await db`INSERT INTO run_events(id,type,payload) VALUES(${randomUUID()},'SETTINGS_PRIMARY_BOT_UPDATED',
          ${db.json({
            actor: "owner",
            previousBotId: previous.primaryBotId,
            primaryBotId: command.botId,
            revision: result.revision,
            reason: "selected",
          })})`;
        check();
        return result;
      });
    },
  };
}
