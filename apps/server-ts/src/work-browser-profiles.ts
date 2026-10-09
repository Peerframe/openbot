import { modelSelectionSchema, nodeIdSchema } from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import { z } from "zod";
import type { ModelConnections } from "./model-connections.js";
import type { WorkDb, WorkTaskRow } from "./work-handoff.js";
import { workCanonical } from "./work-values.js";

const profileSchema = z.strictObject({
  kind: z.literal("work_browser_profile"),
  version: z.literal(1),
  taskId: z.string().uuid(),
  botId: z.string().uuid(),
  sourceRunId: z.string().uuid(),
  executionProfile: z.literal("docker-linux"),
  modelSelection: modelSelectionSchema,
  nodeId: nodeIdSchema,
  credentialDigest: z.string().regex(/^[a-f0-9]{64}$/),
  maxCaptures: z.literal(4),
});
/** Exact retained deployment-origin policy. This validates scope; the executor still enforces egress. */
export function workBrowserOrigin(value: string) {
  if (value.length > 2048 || /[^\x21-\x7e]|\\/.test(value))
    throw new WorkConflict("browser_origin_invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WorkConflict("browser_origin_invalid");
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) ||
    (url.protocol === "http:" && url.hostname !== "127.0.0.1") ||
    (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) ||
    value.match(/^https?:\/\/([^/?#]*)/)?.[1] !== url.host
  )
    throw new WorkConflict("browser_origin_invalid");
  return url.origin;
}
const originsSchema = z
  .array(z.string())
  .min(1)
  .max(10)
  .refine((values) => {
    try {
      return (
        new Set(values).size === values.length && values.every((v) => workBrowserOrigin(v) === v)
      );
    } catch {
      return false;
    }
  });
const scopeSchema = z.strictObject({
  kind: z.literal("work_browser_page_scope"),
  version: z.literal(1),
  taskId: z.string().uuid(),
  origins: originsSchema,
  maxActions: z.literal(16),
});
export const workBrowserRoutesSchema = z
  .strictObject({
    browserRoutes: z
      .record(z.string().uuid(), nodeIdSchema)
      .refine((r) => Object.keys(r).length <= 32),
    pageOrigins: z.record(z.string().uuid(), originsSchema).optional(),
  })
  .refine((value) => Object.keys(value.pageOrigins ?? {}).every((id) => id in value.browserRoutes));
export type WorkBrowserRoutes = z.infer<typeof workBrowserRoutesSchema>;
export type WorkBrowserProfile = z.infer<typeof profileSchema>;
export class WorkBrowserProfiles {
  private readonly options: WorkBrowserRoutes;
  constructor(
    private readonly models: ModelConnections,
    options: WorkBrowserRoutes,
  ) {
    this.options = workBrowserRoutesSchema.parse(options);
  }
  has(botId: string) {
    return Object.hasOwn(this.options.browserRoutes, botId);
  }
  private async source(db: WorkDb, task: WorkTaskRow) {
    const [row] =
      await db`SELECT s.*,r.bot_id,r.node_id,r.execution_profile,r.model_selection,r.instruction,
      r.channel_id AS run_channel,r.source_message_id AS run_message,m.channel_id AS message_channel,b.computer_profile
      FROM work_sources s JOIN runs r ON r.id=s.legacy_run_id JOIN messages m ON m.id=s.source_message_id
      JOIN bots b ON b.id=r.bot_id JOIN channel_bots cb ON cb.channel_id=s.channel_id AND cb.bot_id=b.id
      JOIN channels c ON c.id=s.channel_id WHERE s.task_id=${task.id} AND b.deleted_at IS NULL AND c.deleted_at IS NULL FOR SHARE OF s,r,m,b,cb,c`;
    if (
      !row ||
      row.bot_id !== task.bot_id ||
      row.node_id !== null ||
      row.model_selection !== null ||
      row.execution_profile !== "docker-linux" ||
      row.computer_profile !== "docker-linux" ||
      row.instruction !== task.objective ||
      row.run_channel !== row.channel_id ||
      row.message_channel !== row.channel_id ||
      row.run_message !== row.source_message_id ||
      (
        await db`SELECT 1 FROM work_task_profiles WHERE task_id=${task.id} UNION ALL SELECT 1 FROM work_command_profiles WHERE task_id=${task.id}`
      ).length
    )
      throw new WorkConflict("browser_source_changed");
    return row;
  }
  private async current(db: WorkDb, profile: WorkBrowserProfile) {
    if (this.options.browserRoutes[profile.botId] !== profile.nodeId)
      throw new WorkConflict("browser_route_changed");
    if (!(await this.models.resolve(db, profile.modelSelection)))
      throw new WorkConflict("product_model_unconfigured");
    const [node] =
      await db`SELECT credential_digest,revoked_at FROM node_credentials WHERE node_id=${profile.nodeId} FOR SHARE`;
    const [bound] =
      await db`SELECT node_id,payload FROM run_events WHERE bot_id=${profile.botId} AND type='BROWSER_HOST_BOUND' ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`;
    if (
      !node ||
      node.revoked_at !== null ||
      node.credential_digest !== profile.credentialDigest ||
      !bound ||
      bound.node_id !== profile.nodeId ||
      workCanonical(bound.payload).wire !==
        workCanonical({ credentialDigest: profile.credentialDigest }).wire
    )
      throw new WorkConflict("browser_identity_changed");
  }
  async capture(db: WorkDb, task: WorkTaskRow) {
    const source = await this.source(db, task),
      nodeId = this.options.browserRoutes[task.bot_id];
    if (!nodeId) throw new WorkConflict("browser_route_changed");
    const [bot] =
      await db`SELECT configuration->'model' AS selection FROM bots WHERE id=${task.bot_id} FOR SHARE`;
    const [node] =
      await db`SELECT credential_digest FROM node_credentials WHERE node_id=${nodeId} FOR SHARE`;
    const profile = profileSchema.parse({
      kind: "work_browser_profile",
      version: 1,
      taskId: task.id,
      botId: task.bot_id,
      sourceRunId: source.legacy_run_id,
      executionProfile: "docker-linux",
      modelSelection: bot?.selection,
      nodeId,
      credentialDigest: node?.credential_digest,
      maxCaptures: 4,
    });
    await this.current(db, profile);
    await db`INSERT INTO work_browser_profiles(task_id,source_run_id,bot_id,model_selection,profile,profile_digest)
      VALUES(${task.id},${profile.sourceRunId},${task.bot_id},${db.json(profile.modelSelection)},${db.json(profile)},${workCanonical(profile).digest})`;
    const origins = this.options.pageOrigins?.[task.bot_id];
    if (origins) {
      const scope = scopeSchema.parse({
        kind: "work_browser_page_scope",
        version: 1,
        taskId: task.id,
        origins,
        maxActions: 16,
      });
      await db`INSERT INTO work_browser_page_scopes(task_id,scope,scope_digest) VALUES(${task.id},${db.json(scope)},${workCanonical(scope).digest})`;
    }
  }
  async pageScope(db: WorkDb, task: WorkTaskRow) {
    const [row] =
      await db`SELECT scope,scope_digest FROM work_browser_page_scopes WHERE task_id=${task.id} FOR SHARE`;
    if (!row) return null;
    const scope = scopeSchema.parse(row.scope);
    if (
      scope.taskId !== task.id ||
      workCanonical(scope).digest !== row.scope_digest ||
      workCanonical(scope.origins).wire !==
        workCanonical(this.options.pageOrigins?.[task.bot_id] ?? null).wire
    )
      throw new WorkConflict("browser_page_scope_changed");
    return { scope, sha256: String(row.scope_digest) };
  }
  async resolve(db: WorkDb, task: WorkTaskRow) {
    const source = await this.source(db, task);
    const [row] = await db`SELECT * FROM work_browser_profiles WHERE task_id=${task.id} FOR SHARE`;
    if (!row) throw new WorkConflict("browser_profile_required");
    const profile = profileSchema.parse(row.profile);
    if (
      profile.taskId !== task.id ||
      profile.botId !== task.bot_id ||
      profile.sourceRunId !== source.legacy_run_id ||
      row.source_run_id !== profile.sourceRunId ||
      row.bot_id !== profile.botId ||
      workCanonical(row.model_selection).wire !== workCanonical(profile.modelSelection).wire ||
      workCanonical(profile).digest !== row.profile_digest
    )
      throw new WorkConflict("browser_profile_changed");
    await this.current(db, profile);
    return { profile, sha256: String(row.profile_digest), page: await this.pageScope(db, task) };
  }
}
