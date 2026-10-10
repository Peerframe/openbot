/** Projects committed invalidations to bounded authenticated SSE streams without reconnecting a lost listener. */
import { notificationConnection } from "./database-pool.js";
import { reportFailure } from "./logging.js";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { messageProjection, runProjection } from "./channel-read-projection.js";
import { messagesQuery, runsQuery } from "./channel-read-query.js";
import { readWorkspace } from "./product-workspace.js";
import { refuse } from "./owner-transaction.js";
import type { ProductRoute } from "./product-identity.js";

export class ProductStream {
  constructor(readonly stream: Readable) {}
}
// Raw LISTEN deliberately avoids Postgres.js's reconnecting listen helper: losing a
// committed invalidation stops this candidate's streams until an explicit restart.
export class ProductInvalidations {
  private revision = 0;
  private failed = false;
  private ready = false;
  private readonly db;
  constructor(databaseUrl: string) {
    this.db = notificationConnection(databaseUrl, (channel, payload) => {
      if (channel === "openbot_product_changed" && payload === "") this.revision++;
    }, () => {
      if (this.ready && !this.failed) {
        this.failed = true;
        reportFailure("event-listener-disconnected", new Error("Event listener disconnected."));
      }
    });
  }
  async start() {
    await this.db.unsafe("LISTEN openbot_product_changed");
    this.ready = true;
  }
  current() {
    if (!this.ready || this.failed) return refuse(503, "product_invalidation_unavailable");
    return this.revision;
  }
  close() {
    this.ready = false;
    return this.db.end({ timeout: 1 });
  }
}
const event = (name: string, payload: unknown) =>
  `event: ${name}\nretry: 2000\ndata: ${JSON.stringify(payload)}\n\n`;
export function eventRoutes(invalidations: ProductInvalidations): ProductRoute[] {
  return ["/api/v1/workspace/events", "/api/v1/channels/{channel_id}/events"].map((path) => ({
    method: "GET",
    path,
    kind: "product",
    execute: async () => {
      throw new Error("Streaming operation.");
    },
    remote: async (owner, ids, _body, signal, request) => {
      const channelId = ids[0];
      let previous: string | undefined,
        previousBots: Map<string, string | undefined> | undefined,
        previousMessages: Set<string> | undefined;
      const observe = async () => {
        const revision = invalidations.current();
        if (channelId === undefined) {
          const { snapshot, runtimeRevision } = await readWorkspace(owner, request, signal);
          const currentBots = new Map(
            snapshot.bots.map((bot) => [bot.id, JSON.stringify(bot.appearance)]),
          );
          const events: string[] = [];
          if (previousBots)
            for (const [id, appearance] of currentBots)
              if (previousBots.has(id) && previousBots.get(id) !== appearance)
                events.push(
                  event("employee.profile.changed", {
                    type: "employee.profile.changed",
                    botId: id,
                    sections: ["identity"],
                    occurredAt: new Date().toISOString(),
                  }),
                );
          previousBots = currentBots;
          return {
            state: JSON.stringify([snapshot, runtimeRevision, revision]),
            events,
            ready: event("workspace.ready", { type: "workspace.ready", nodes: snapshot.nodes }),
          };
        }
        const result = await owner(
          async (db) => {
            const q = messagesQuery(channelId, 100);
            const messages = await db.unsafe(q.text, q.values);
            if (!messages.length) return refuse(404, "channel_not_found");
            const runs = await db.unsafe(runsQuery, [channelId]);
            if (messages.some((row) => row.oversized) || runs.some((row) => row.oversized))
              return refuse(503, "channel_projection_limit");
            return {
              messages: messages.filter((row) => row.id != null).map(messageProjection),
              runs: runs.filter((row) => row.id != null).map(runProjection),
            };
          },
          signal,
          "repeatable read",
        );
        const currentIds = new Set(result.messages.map((message) => message.id));
        const events = result.messages
          .filter((message) => previousMessages && !previousMessages.has(message.id))
          .map((message) =>
            event("message.created", { type: "message.created", channelId, message }),
          );
        previousMessages = currentIds;
        return {
          state: JSON.stringify([result, revision]),
          events,
          ready: event("channel.ready", { type: "channel.ready", channelId }),
        };
      };
      // First projection/authority failure is still an HTTP error, before SSE headers.
      const first = await observe();
      async function* frames() {
        let current = first;
        try {
          while (!signal.aborted) {
            for (const value of current.events) yield value;
            yield current.state === previous ? "event: heartbeat\ndata: alive\n\n" : current.ready;
            previous = current.state;
            await delay(3000, undefined, { signal });
            current = await observe();
          }
        } catch {
          /* Poll authority/storage failure closes; never reconnects or discloses an error body. */
        }
      }
      return new ProductStream(Readable.from(frames(), { highWaterMark: 1 }));
    },
  }));
}
