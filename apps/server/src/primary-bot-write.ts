/** Commits primary Bot selection, revision checks and audit under one Owner transaction. */
import { ownerTransactions } from "./owner-transaction.js";
import { randomUUID } from "node:crypto";
import { workspacePrimaryBotInputSchema, workspacePrimaryBotSchema } from "@openbot/protocol";
import { z } from "zod";

import { HttpFailure } from "./http-errors.js";
// Python's bounded Bot identifier counts Unicode code points. Keep the shared strict
// shape and mathematical-integer revision, with that existing input compatibility adapter.
const botIdentifier = z
  .string()
  .refine((value) => [...value].length >= 1 && [...value].length <= 128)
  .nullable();
const commandSchema = workspacePrimaryBotInputSchema.extend({ botId: botIdentifier });
const projectionSchema = workspacePrimaryBotSchema.extend({ primaryBotId: botIdentifier });

export function primaryBotWriter(databaseUrl: string) {
  const store = ownerTransactions(databaseUrl, 4);
  const authorized = store.run;
  return {
    verify: () => store.verify(async (db) => {
      await db`SELECT workspace_id,primary_bot_id,revision FROM workspace_settings WHERE false`;
      await db`SELECT id,deleted_at FROM bots WHERE false`;
      await db`SELECT id,type,payload FROM run_events WHERE false`;
    }),
    close: store.close,
    // Preflight precedes body parsing, as in Python. The mutation rechecks/locks the
    // session after body collection, so a slow body never carries stale authority.
    preflight: (token: string | undefined, signal: AbortSignal) =>
      authorized(token, signal, async () => undefined),
    update(token: string | undefined, value: unknown, signal: AbortSignal) {
      return authorized(token, signal, async (db, check) => {
        const parsed = commandSchema.safeParse(value);
        if (!parsed.success) throw new HttpFailure(422, { error: "Invalid request input." });
        const command = parsed.data;
        const rows =
          await db`SELECT primary_bot_id AS "primaryBotId",revision FROM workspace_settings
          WHERE workspace_id='workspace' FOR UPDATE`;
        check();
        if (rows.length !== 1)
          throw new HttpFailure(503, { error: "workspace_settings_unavailable" });
        const previous = rows[0]!;
        if (command.expectedRevision !== previous.revision)
          throw new HttpFailure(409, { error: "workspace_revision_conflict" });
        if (command.botId !== null) {
          // Python refuses non-scalar surrogate text during SQL encoding; Node otherwise
          // substitutes U+FFFD, which could select a different persisted identifier.
          if (
            [...command.botId].some((character) => {
              const code = character.codePointAt(0)!;
              return code === 0 || (code >= 0xd800 && code <= 0xdfff);
            })
          )
            throw new HttpFailure(422, { error: "invalid_unicode_input" });
          // Workspace first, then Bot: identical to identity creation/deletion/import.
          const bots =
            await db`SELECT id FROM bots WHERE id=${command.botId} AND deleted_at IS NULL FOR SHARE`;
          check();
          if (bots.length !== 1) throw new HttpFailure(404, { error: "bot_not_found" });
        }
        if (command.botId === previous.primaryBotId) return projectionSchema.parse(previous);
        if (previous.revision === 2147483647)
          throw new HttpFailure(409, { error: "workspace_revision_exhausted" });
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
