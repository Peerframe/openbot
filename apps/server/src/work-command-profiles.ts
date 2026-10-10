/** Freezes approved command policy and checks its current deployment binding. */
import { commandPreparationBindingSchema, modelSelectionSchema } from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import { z } from "zod";
import type { ModelConnections } from "./model-connections.js";
import { commandRouteSchema, workCommandSchema } from "./work-command-contract.js";
import { commandValue } from "./work-command-values.js";
import type { WorkDb, WorkTaskRow } from "./work-handoff.js";
import { workCanonical } from "./work-values.js";

const { nodeId: identity, profileDigest: digest } = commandPreparationBindingSchema.shape;
const policySchema = z
  .object({ image: workCommandSchema.shape.image, limits: workCommandSchema.shape.limits })
  .strict();
const profileSchema = z
  .object({
    kind: z.literal("work_command_profile"),
    version: z.literal(1),
    taskId: identity,
    botId: identity,
    sourceRunId: identity,
    executionProfile: z.literal("docker-linux"),
    modelSelection: modelSelectionSchema,
    route: commandRouteSchema,
    credentialDigest: digest,
    policyId: identity,
    policyDigest: digest,
  })
  .strict();
export type WorkCommandProfile = z.infer<typeof profileSchema>;
export type WorkCommandPolicy = z.infer<typeof policySchema>;
export async function commandSource(db: WorkDb, task: WorkTaskRow) {
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
      await db`SELECT 1 FROM work_task_profiles WHERE task_id=${task.id} UNION ALL SELECT 1 FROM work_browser_profiles WHERE task_id=${task.id}`
    ).length
  )
    throw new WorkConflict("command_source_changed");
  return row;
}
/** Insert-only command snapshots. Policy, route and credential selection come from trusted startup. */
export class WorkCommandProfiles {
  private readonly policies = new Map<string, { sha256: string; policy: WorkCommandPolicy }>();
  private readonly route: z.infer<typeof commandRouteSchema>;
  private readonly policyId: string;
  constructor(
    private readonly models: ModelConnections,
    options: {
      policies: Record<string, WorkCommandPolicy>;
      route: z.infer<typeof commandRouteSchema>;
      policyId: string;
    },
  ) {
    commandValue(options);
    const entries = Object.entries(options.policies);
    if (entries.length < 1 || entries.length > 32)
      throw new WorkConflict("command_policy_required");
    for (const [id, value] of entries) {
      const policy = policySchema.parse(value);
      identity.parse(id);
      this.policies.set(id, { sha256: workCanonical(policy).digest, policy });
    }
    this.route = commandRouteSchema.parse(options.route);
    this.policyId = identity.parse(options.policyId);
    if (!this.policies.has(this.policyId)) throw new WorkConflict("command_policy_required");
  }
  private async current(db: WorkDb, profile: WorkCommandProfile) {
    if (
      this.policies.get(profile.policyId)?.sha256 !== profile.policyDigest ||
      profile.policyId !== this.policyId ||
      workCanonical(profile.route).wire !== workCanonical(this.route).wire
    )
      throw new WorkConflict("command_policy_changed");
    if (!(await this.models.resolve(db, profile.modelSelection)))
      throw new WorkConflict("product_model_unconfigured");
    const [node] =
      await db`SELECT credential_digest,revoked_at FROM node_credentials WHERE node_id=${profile.route.nodeId} FOR SHARE`;
    if (!node || node.revoked_at !== null || node.credential_digest !== profile.credentialDigest)
      throw new WorkConflict("command_identity_changed");
  }
  async capture(db: WorkDb, task: WorkTaskRow) {
    const source = await commandSource(db, task);
    const [bot] =
      await db`SELECT configuration->'model' AS selection FROM bots WHERE id=${task.bot_id} FOR SHARE`;
    const [node] =
      await db`SELECT credential_digest FROM node_credentials WHERE node_id=${this.route.nodeId} FOR SHARE`;
    const profile = profileSchema.parse({
      kind: "work_command_profile",
      version: 1,
      taskId: task.id,
      botId: task.bot_id,
      sourceRunId: source.legacy_run_id,
      executionProfile: "docker-linux",
      modelSelection: bot?.selection,
      route: this.route,
      credentialDigest: node?.credential_digest,
      policyId: this.policyId,
      policyDigest: this.policies.get(this.policyId)!.sha256,
    });
    await this.current(db, profile);
    await db`INSERT INTO work_command_profiles(task_id,source_run_id,bot_id,model_selection,profile,profile_digest) VALUES(${task.id},${profile.sourceRunId},${task.bot_id},${db.json(profile.modelSelection)},${db.json(profile)},${workCanonical(profile).digest})`;
  }
  async resolve(db: WorkDb, task: WorkTaskRow) {
    const source = await commandSource(db, task);
    const [row] = await db`SELECT * FROM work_command_profiles WHERE task_id=${task.id} FOR SHARE`;
    if (!row) throw new WorkConflict("command_profile_required");
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
      throw new WorkConflict("command_profile_changed");
    await this.current(db, profile);
    return { profile, sha256: String(row.profile_digest) };
  }
  policy(profile: WorkCommandProfile) {
    const entry = this.policies.get(profile.policyId);
    if (!entry || entry.sha256 !== profile.policyDigest)
      throw new WorkConflict("command_policy_changed");
    return structuredClone(entry.policy);
  }
  async checkCommand(profile: WorkCommandProfile, value: unknown) {
    commandValue(value);
    const command = await workCommandSchema.parseAsync(value),
      policy = this.policy(profile);
    if (
      command.image !== policy.image ||
      workCanonical(command.limits).wire !== workCanonical(policy.limits).wire
    )
      throw new WorkConflict("command_policy_changed");
    return command;
  }
}
