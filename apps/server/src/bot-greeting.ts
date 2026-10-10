/** Schedules one bounded Bot greeting and records fixed failure categories without exposing provider data. */
import { databasePool } from "./database-pool.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import postgres from "postgres";
import { messageProjection } from "./channel-read-projection.js";
import { generateGreeting } from "./greeting-network.js";
import { GreetingFailure } from "./greeting-text.js";
import type { ModelConnections, ResolvedConnection } from "./model-connections.js";
import type { ModelTransport } from "./model-network.js";
import { HttpFailure } from "./http-errors.js";
import type { AuthorizedProductOperation as Owner } from "./product-identity.js";
type DB = postgres.TransactionSql;
type Selection = { connectionId: string; modelId: string };
type Claimed = { selection: Selection; resolved: ResolvedConnection; payload: unknown };
export class BotGreetings {
  private readonly pool: ReturnType<typeof databasePool>;
  #jobs = new Set<Promise<unknown>>();
  #modelActive = 0;
  #shutdown = new AbortController();
  #audit: ReturnType<typeof postgres>;
  constructor(
    databaseUrl: string,
    readonly models: ModelConnections,
    readonly transport?: ModelTransport,
  ) {
    // Only fixed, content-free failure categories may use this internal connection after Owner
    // expiry. Successful messages always use the original Owner transaction and its final check.
    this.pool = databasePool(databaseUrl);
    this.#audit = this.pool.sql;
  }
  schedule(owner: Owner, bot: string, channel: string) {
    const job = this.run(owner, bot, channel);
    this.#jobs.add(job);
    void job.finally(() => this.#jobs.delete(job));
  }
  async close() {
    this.#shutdown.abort();
    await Promise.allSettled(this.#jobs);
    await this.pool.close();
  }
  private async current(db: DB, bot: string, channel: string) {
    const rows =
      await db`SELECT id FROM channels WHERE id=${channel} AND direct_bot_id=${bot} AND deleted_at IS NULL FOR UPDATE`;
    const [row] =
      await db`SELECT left(name,64) AS name,configuration->'model' AS model FROM bots WHERE id=${bot} AND deleted_at IS NULL FOR SHARE`;
    if (!rows.length || !row) throw new GreetingFailure("bot_or_channel_deleted");
    if (
      (
        await db`SELECT 1 WHERE EXISTS(SELECT 1 FROM messages WHERE channel_id=${channel}) OR EXISTS(SELECT 1 FROM run_events WHERE channel_id=${channel} AND type='MESSAGE_CREATED' AND payload->>'authorType'='human')`
      ).length
    )
      throw new GreetingFailure("conversation_started");
    return row;
  }
  private async selected(db: DB, bot: string, channel: string, selected: Claimed) {
    const current = await this.current(db, bot, channel);
    if (!isDeepStrictEqual(current.model, selected.selection))
      throw new GreetingFailure("model_changed");
    const resolved = await this.models.resolve(db, selected.selection, selected.resolved.revision);
    if (!isDeepStrictEqual(resolved, selected.resolved)) throw new GreetingFailure("model_changed");
  }
  private async failure(bot: string, channel: string, reason: string) {
    try {
      await this
        .#audit`INSERT INTO run_events(id,bot_id,channel_id,type,payload) SELECT ${randomUUID()},b.id,c.id,'BOT_GREETING_FAILED',${this.#audit.json({ reason })} FROM bots b JOIN channels c ON c.direct_bot_id=b.id WHERE b.id=${bot} AND c.id=${channel}`;
    } catch {
      /* No retry or alternate audit authority during a database outage. */
    }
  }
  async run(owner: Owner, bot: string, channel: string) {
    const signal = this.#shutdown.signal;
    try {
      const selected = await owner(async (db) => {
        const row = await this.current(db, bot, channel);
        if (
          (await db`SELECT 1 FROM run_events WHERE bot_id=${bot} AND type='BOT_GREETING_STARTED'`)
            .length
        )
          return null;
        await db`INSERT INTO run_events(id,bot_id,channel_id,type,payload) VALUES(${randomUUID()},${bot},${channel},'BOT_GREETING_STARTED','{}'::jsonb)`;
        const resolved = row.model ? await this.models.resolve(db, row.model) : null;
        if (!resolved) return { unavailable: true } as const;
        const others =
          await db`SELECT left(name,64) AS name,left(role,160) AS role FROM bots WHERE id<>${bot} AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 12`;
        return { selection: row.model as Selection, resolved, payload: { name: row.name, others } };
      }, signal);
      if (selected === null) return;
      if ("unavailable" in selected) throw new GreetingFailure("model_unavailable");
      if (this.#modelActive >= 8) throw new GreetingFailure("operation_failed");
      this.#modelActive++;
      const deadline = AbortSignal.timeout(15000),
        modelSignal = AbortSignal.any([signal, deadline]);
      let text: string;
      try {
        text = await generateGreeting(
          selected.resolved,
          selected.payload,
          () => owner((db) => this.selected(db, bot, channel, selected), modelSignal),
          modelSignal,
          this.transport,
        );
      } catch (error) {
        if (signal.aborted) throw new GreetingFailure("cancelled");
        if (deadline.aborted) throw new GreetingFailure("timeout");
        let cause: unknown = error;
        for (let n = 0; n < 4 && cause instanceof Error; n++, cause = cause.cause)
          if (cause instanceof GreetingFailure || cause instanceof HttpFailure) throw cause;
        throw error;
      } finally {
        this.#modelActive--;
      }
      // The network deadline never aborts an otherwise successful SQL publication commit.
      return await owner(async (db) => {
        await this.selected(db, bot, channel, selected);
        const [message] =
          await db`INSERT INTO messages(id,channel_id,author_type,author_id,content,origin) VALUES(${randomUUID()},${channel},'bot',${bot},${text},'greeting') RETURNING *`;
        await db`INSERT INTO run_events(id,bot_id,channel_id,type,payload) VALUES(${randomUUID()},${bot},${channel},'MESSAGE_CREATED',${db.json({ messageId: message!.id, authorType: "bot", origin: "greeting" })})`;
        await db`SELECT pg_notify('openbot_product_changed','')`;
        return messageProjection(message!);
      }, signal);
    } catch (error) {
      await this.failure(
        bot,
        channel,
        error instanceof GreetingFailure
          ? error.reason
          : error instanceof HttpFailure && error.status === 401
            ? "authority_changed"
            : signal.aborted
              ? "cancelled"
              : "operation_failed",
      );
    }
  }
}
