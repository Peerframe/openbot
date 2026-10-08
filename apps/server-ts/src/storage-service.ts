import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { storageSettingsInputSchema, trashCleanupInputSchema } from "@openbot/protocol";
import { PurgeFiles, purgeMarker } from "./attachment-purge-files.js";
import { type ReferencedAttachment, withReferenceCounts } from "./attachment-references.js";
import { hasIntegerTokens } from "./json-input.js";
import { boundedAdmission } from "./owner-auth-crypto.js";
import { attachmentId, type Attachment, FileSession, OwnerFiles } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import { WriteFailure } from "./primary-bot-write.js";
import { attachmentChannel } from "./product-attachments.js";
import type { AuthorizedProductOperation } from "./product-identity.js";
import { measuredUsage } from "./storage-usage.js";

type DB = postgres.TransactionSql;
type Cleanup = {
  removed: number;
  retained: Array<{
    id: string;
    name: string;
    referenceCount: { messages: number; tasks: number };
  }>;
  retainedCount: number;
  retainedHasMore: boolean;
  freedBytes: number;
};
const empty = (): Cleanup => ({
  removed: 0,
  retained: [],
  retainedCount: 0,
  retainedHasMore: false,
  freedBytes: 0,
});
const referenced = (item: ReferencedAttachment) =>
  item.referenceCount.messages > 0 || item.referenceCount.tasks > 0;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const date = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();
function settings(row: postgres.Row | undefined) {
  if (!row) return refuse(503, "storage_settings_unavailable");
  return {
    revision: row.revision,
    trashAutoPurgeDays: row.trash_auto_purge_days,
    updatedAt: date(row.updated_at),
    lastAutoPurgeAt: row.last_auto_purge_at ? date(row.last_auto_purge_at) : null,
  };
}
export class StorageService {
  private readonly sql: postgres.Sql;
  private readonly admit = boundedAdmission(2, true);
  private readonly closing = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<unknown> | undefined;
  private started = false;
  private pendingWake = false;
  constructor(
    databaseUrl: string,
    readonly files: OwnerFiles,
    readonly objectRoot: string,
    readonly artifactRoot?: string,
  ) {
    this.sql = postgres(databaseUrl, {
      max: 2,
      connect_timeout: 3,
      onnotice: () => undefined,
      connection: {
        application_name: "openbot-ts-storage-maintenance",
        statement_timeout: 3000,
        lock_timeout: 1000,
        idle_in_transaction_session_timeout: 5000,
        search_path: "public,pg_catalog",
        timezone: "UTC",
      },
    });
    files.recover = (session) => this.recover(session);
  }
  private internal<T>(
    operation: (db: DB) => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    return this.admit(
      signal,
      async (check) =>
        (await this.sql.begin(async (db) => {
          check();
          const value = await operation(db);
          check();
          return value;
        })) as T,
    );
  }
  async verify() {
    await this.sql`SELECT id,channel_id,operation_id,freed_bytes FROM attachment_purges LIMIT 0`;
    await this
      .sql`SELECT owner_id,revision,trash_auto_purge_days,last_auto_purge_at FROM owner_storage_settings LIMIT 0`;
    await this.files.withLock(async () => undefined);
  }
  async recover(session: FileSession) {
    const journal = new PurgeFiles(session);
    for (const name of journal.journals()) {
      let value: ReturnType<PurgeFiles["read"]>;
      try {
        value = journal.read(name);
      } catch (error) {
        if (!missing(error)) throw error;
        journal.discardUnstarted(name);
        continue;
      }
      const rows = await this.internal(
        (db) =>
          db`SELECT id,channel_id FROM attachment_purges WHERE operation_id=${value.operation}`,
      );
      const expected = new Map(value.entries.map((item) => [item.id, item.channelId]));
      if (rows.some((row) => expected.get(row.id) !== row.channel_id))
        return refuse(503, "purge_receipt_refused");
      journal.resolve(name, value, new Set(rows.map((row) => row.id as string)));
    }
  }
  catalog(session: FileSession) {
    const ids = session
      .names()
      .filter((name) => name.endsWith(".json") && attachmentId.test(name.slice(0, -5)))
      .map((name) => name.slice(0, -5))
      .sort();
    if (ids.length > 1024) return refuse(503, "attachment_count_limit");
    const channel: Attachment[] = [],
      owner: Attachment[] = [];
    for (const id of ids)
      try {
        const raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(session.read(id + ".json", 4096)),
        );
        if (raw.channelId !== undefined) channel.push(session.metadata(raw.channelId, id));
        else owner.push(session.metadata(null, id));
      } catch {
        return refuse(503, "storage_attachment_catalog_unavailable");
      }
    return { channel, owner };
  }
  async counts(db: DB, items: readonly Attachment[]) {
    const groups = new Map<string, Attachment[]>();
    for (const item of items) {
      if (!item.channelId) return refuse(503, "storage_attachment_catalog_unavailable");
      const group = groups.get(item.channelId) ?? [];
      group.push(item);
      groups.set(item.channelId, group);
    }
    const result: ReferencedAttachment[] = [];
    for (const channel of [...groups.keys()].sort())
      result.push(...(await withReferenceCounts(db, channel, groups.get(channel)!)));
    return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  private async remove(
    db: DB,
    session: FileSession,
    items: readonly Attachment[],
    actor: string,
    reason: string,
    single = false,
  ): Promise<Cleanup> {
    if (!items.length) return empty();
    const checkSingle = (items: ReferencedAttachment[]) => {
      if (single && referenced(items[0]!))
        throw new WriteFailure(409, {
          error: "attachment_referenced",
          referenceCount: items[0]!.referenceCount,
        });
    };
    const first = await this.counts(db, items);
    checkSingle(first);
    const journal = new PurgeFiles(session),
      operation = journal.stage(first);
    // Count predicates cannot prevent phantom INSERTs. Hold table SHARE through receipt commit.
    await db`LOCK TABLE messages,runs IN SHARE MODE`;
    const final = await this.counts(db, items);
    checkSingle(final);
    const removed = final.filter((item) => !referenced(item)),
      retained = final.filter(referenced);
    const value = journal.read(".purge-" + operation),
      entries = new Map(value.entries.map((item) => [item.id, item]));
    const freed = removed.map((item) =>
      Math.max(
        0,
        journal.stagedBytes(".purge-" + operation, entries.get(item.id)!) -
          purgeMarker({ id: item.id, channelId: item.channelId! }).length,
      ),
    );
    if (removed.length) {
      await db`INSERT INTO attachment_purges(id,channel_id,operation_id,freed_bytes)
        SELECT id,channel_id,${operation},freed_bytes FROM jsonb_to_recordset(${db.json(removed.map((item, index) => ({ id: item.id, channel_id: item.channelId!, freed_bytes: freed[index]! })))}) AS x(id text,channel_id text,freed_bytes integer)`;
      await db`INSERT INTO run_events(id,channel_id,type,payload)
        SELECT id,channel_id,'CHANNEL_ATTACHMENT_PURGED',payload FROM jsonb_to_recordset(${db.json(removed.map((item, index) => ({ id: randomUUID(), channel_id: item.channelId!, payload: { actor, reason, attachmentId: item.id, fileName: item.name, sizeBytes: item.sizeBytes, freedBytes: freed[index]! } })))}) AS x(id text,channel_id text,payload jsonb)`;
    }
    return {
      removed: removed.length,
      retained: retained
        .slice(0, 100)
        .map((item) => ({ id: item.id, name: item.name, referenceCount: item.referenceCount })),
      retainedCount: retained.length,
      retainedHasMore: retained.length > 100,
      freedBytes: freed.reduce((sum, value) => sum + value, 0),
    };
  }
  private async mutation<T>(
    owner: AuthorizedProductOperation,
    signal: AbortSignal,
    operation: (db: DB, session: FileSession) => Promise<T>,
  ) {
    return this.files.withLock(async (session) => {
      try {
        const result = await owner((db) => operation(db, session), session.signal);
        await this.recover(session);
        return result;
      } catch (error) {
        await this.recover(session);
        throw error;
      }
    }, signal);
  }
  async purge(owner: AuthorizedProductOperation, channel: string, id: string, signal: AbortSignal) {
    return this.mutation(owner, signal, async (db, session) => {
      await attachmentChannel(db, channel);
      const [prior] =
        await db`SELECT freed_bytes FROM attachment_purges WHERE id=${id} AND channel_id=${channel}`;
      if (prior) return { id, purged: true, freedBytes: prior.freed_bytes };
      const item = session.metadata(channel, id);
      if (!item.deletedAt) return refuse(409, "attachment_not_in_trash");
      const result = await this.remove(db, session, [item], "owner", "permanent_delete", true);
      return { id, purged: true, freedBytes: result.freedBytes };
    });
  }
  async cleanup(
    owner: AuthorizedProductOperation,
    channel: string | null,
    body: unknown,
    signal: AbortSignal,
  ) {
    return this.mutation(owner, signal, async (db, session) => {
      await attachmentChannel(db, channel);
      const input = trashCleanupInputSchema.safeParse(body);
      if (!input.success) return refuse(422, "invalid_cleanup_request");
      const key = input.data.requestKey;
      const [prior] =
        channel === null
          ? await db`SELECT response FROM storage_cleanup_receipts WHERE request_key=${key}`
          : await db`SELECT response FROM attachment_cleanup_receipts WHERE channel_id=${channel} AND request_key=${key}`;
      if (prior) return prior.response;
      const { channel: items } = this.catalog(session);
      let trash = items.filter(
        (item) => item.deletedAt && (channel === null || item.channelId === channel),
      );
      let count = 0;
      if (channel === null) {
        const allowed = await this.liveChannels(db, trash);
        count = allowed.size;
        trash = trash.filter((item) => allowed.has(item.channelId!));
      }
      const result = {
        ...(await this.remove(
          db,
          session,
          trash,
          "owner",
          channel === null ? "empty_trash_all" : "empty_trash",
        )),
        ...(channel === null ? { channelCount: count } : {}),
      };
      if (channel === null)
        await db`INSERT INTO storage_cleanup_receipts(request_key,response) VALUES(${key},${db.json(result)})`;
      else
        await db`INSERT INTO attachment_cleanup_receipts(channel_id,request_key,response) VALUES(${channel},${key},${db.json(result)})`;
      return result;
    });
  }
  async getSettings(db: DB) {
    const [row] = await db`SELECT * FROM owner_storage_settings WHERE owner_id='owner'`;
    return settings(row);
  }
  async saveSettings(owner: AuthorizedProductOperation, body: unknown, signal: AbortSignal) {
    const input = storageSettingsInputSchema.safeParse(body);
    if (!input.success || !hasIntegerTokens(body, ["expectedRevision", "trashAutoPurgeDays"]))
      return refuse(422, "invalid_storage_settings");
    const value = input.data;
    const result = await owner(async (db) => {
      let [row] = await db`SELECT * FROM owner_storage_settings WHERE owner_id='owner' FOR UPDATE`;
      if (!row) return refuse(503, "storage_settings_unavailable");
      if (row.revision !== value.expectedRevision)
        return refuse(409, "storage_settings_revision_conflict");
      if (row.trash_auto_purge_days !== value.trashAutoPurgeDays) {
        if (row.revision === 2147483647) return refuse(409, "storage_settings_revision_exhausted");
        [row] =
          await db`UPDATE owner_storage_settings SET trash_auto_purge_days=${value.trashAutoPurgeDays},revision=revision+1,last_auto_purge_at=NULL,updated_at=clock_timestamp() WHERE owner_id='owner' RETURNING *`;
        await db`INSERT INTO run_events(id,type,payload) VALUES(${randomUUID()},'SETTINGS_STORAGE_UPDATED',${db.json({ actor: "owner", revision: row!.revision, trashAutoPurgeDays: row!.trash_auto_purge_days })})`;
      }
      return settings(row);
    }, signal);
    this.wake();
    return result;
  }
  async usage(owner: AuthorizedProductOperation, signal: AbortSignal) {
    return this.files.withLock(
      (session) =>
        owner(async (db) => {
          const { channel, owner } = this.catalog(session),
            trash = await this.counts(
              db,
              channel.filter((item) => item.deletedAt),
            );
          return measuredUsage(
            db,
            this.files,
            this.objectRoot,
            this.artifactRoot,
            channel,
            owner,
            trash,
          );
        }, session.signal),
      signal,
    );
  }
  private async liveChannels(db: DB, items: readonly Attachment[]) {
    const ids = [...new Set(items.map((item) => item.channelId!))].sort();
    const rows =
      await db`SELECT id FROM channels WHERE id IN (SELECT jsonb_array_elements_text(${db.json(ids)})) AND deleted_at IS NULL ORDER BY id FOR SHARE`;
    return new Set(rows.map((row) => row.id as string));
  }
  private payload(
    outcome: string,
    result: Pick<Cleanup, "removed" | "freedBytes" | "retainedCount"> | null,
    id: string,
  ) {
    return {
      actor: "server",
      operationId: id,
      reason: "trash_auto_purge",
      trashAutoPurgeDays: 30,
      outcome,
      removed: result?.removed ?? null,
      freedBytes: result?.freedBytes ?? null,
      retainedCount: result?.retainedCount ?? null,
    };
  }
  async runDue(signal: AbortSignal = this.closing.signal) {
    let runId: string | undefined;
    return this.files.withLock(async (session) => {
      try {
        const claim = await this.internal(async (db) => {
          const [row] =
            await db`SELECT *,clock_timestamp() AS now FROM owner_storage_settings WHERE owner_id='owner' FOR UPDATE`;
          if (!row) return refuse(503, "storage_settings_unavailable");
          if (
            row.trash_auto_purge_days === null ||
            (row.last_auto_purge_at &&
              row.now.getTime() - row.last_auto_purge_at.getTime() < 86400000)
          )
            return null;
          const id = randomUUID();
          await db`UPDATE owner_storage_settings SET last_auto_purge_at=${row.now} WHERE owner_id='owner'`;
          await db`INSERT INTO run_events(id,type,payload) VALUES(${randomUUID()},'SETTINGS_TRASH_AUTO_PURGE_RUN',${db.json(this.payload("started", null, id))})`;
          return { revision: row.revision as number, now: row.now as Date, id };
        }, session.signal);
        if (!claim) return null;
        runId = claim.id;
        const outcome = await this.internal(async (db) => {
          const [policy] =
            await db`SELECT * FROM owner_storage_settings WHERE owner_id='owner' FOR UPDATE`;
          if (!policy) return refuse(503, "storage_settings_unavailable");
          let result = empty(),
            status = "policy_changed";
          if (policy.revision === claim.revision && policy.trash_auto_purge_days === 30) {
            const { channel } = this.catalog(session);
            let eligible = channel.filter((item) => {
              if (!item.deletedAt) return false;
              const when = Date.parse(item.deletedAt);
              if (
                !Number.isFinite(when) ||
                !/(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/i.test(item.deletedAt)
              )
                return refuse(503, "trash_timestamp_unavailable");
              return when <= claim.now.getTime() - 30 * 86400000;
            });
            if (eligible.length) {
              const allowed = await this.liveChannels(db, eligible);
              eligible = eligible.filter((item) => allowed.has(item.channelId!));
            }
            result = await this.remove(db, session, eligible, "server", "trash_auto_purge");
            status = "completed";
          }
          await db`INSERT INTO run_events(id,type,payload) VALUES(${claim.id},'SETTINGS_TRASH_AUTO_PURGE_RUN',${db.json(this.payload(status, result, claim.id))})`;
          return { outcome: status, ...result };
        }, session.signal);
        await this.recover(session);
        return outcome;
      } catch (error) {
        // A lost COMMIT is not a failed zero-effect run. Recovery and receipt lookup must succeed.
        await this.recover(session);
        if (runId) {
          const id = runId;
          const prior = await this.internal(async (db) => {
            const [row] = await db`SELECT payload FROM run_events WHERE id=${id} FOR UPDATE`;
            if (row) return row.payload;
            await db`INSERT INTO run_events(id,type,payload) VALUES(${id},'SETTINGS_TRASH_AUTO_PURGE_RUN',${db.json(this.payload(signal.aborted ? "cancelled" : "failed", empty(), id))})`;
            return null;
          });
          if (signal.aborted) throw error;
          if (prior) return prior;
        }
        if (signal.aborted) throw error;
        return { outcome: "failed", removed: 0, freedBytes: 0 };
      }
    }, signal);
  }
  start() {
    if (this.started) throw new Error("Storage maintenance already started.");
    this.started = true;
    this.wake();
  }
  private wake() {
    if (!this.started || this.closing.signal.aborted) return;
    if (this.running) {
      this.pendingWake = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.running = this.runDue()
        .catch(() => undefined)
        .finally(() => {
          this.running = undefined;
          if (!this.closing.signal.aborted) {
            if (this.pendingWake) {
              this.pendingWake = false;
              this.wake();
            } else {
              this.timer = setTimeout(() => this.wake(), 3600000);
              this.timer.unref();
            }
          }
        });
    }, 0);
    this.timer.unref();
  }
  async close() {
    this.closing.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.running;
    await this.sql.end({ timeout: 1 });
  }
}
