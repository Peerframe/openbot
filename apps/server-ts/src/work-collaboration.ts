import { modelSelectionSchema } from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import { z } from "zod";
import type { FileSession } from "./owner-files.js";
import type { WorkDb, WorkTaskRow, WorkTransactions } from "./work-handoff.js";
import { workEvent } from "./work-handoff.js";
import {
  currentWork,
  loadWorkActions,
  type WorkAction,
  type WorkLedger,
  type WorkScope,
} from "./work-ledger.js";
import type { WorkModelObservation, WorkTool } from "./work-model.js";
import { createWork } from "./work-public.js";
import { descriptor, nativeWorkScope, nativeWorkSource } from "./work-scope.js";
import { scopeSubset, type WorkRelation, workCreationTree, workTree } from "./work-tree.js";
import { type WorkJson, workCanonical, workText } from "./work-values.js";

export const collaborationNames = [
  "start_task",
  "wait_for_task",
  "delegate_task",
  "list_collaborators",
] as const;
const createInput = z
  .object({
    botId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
    task: z
      .string()
      .max(4000)
      .refine((v) => !!v.trim()),
  })
  .strict();
const waitInput = z
  .object({
    runId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
  })
  .strict();
const createParameters: WorkTool["parameters"] = {
  type: "object" as const,
  properties: {
    botId: { type: "string", format: "uuid" },
    task: { type: "string", minLength: 1, maxLength: 4000 },
  },
  required: ["botId", "task"],
  additionalProperties: false,
};
export const collaborationTools: WorkTool[] = [
  {
    name: "start_task",
    description:
      "Start one task for a colleague explicitly granted to this Task. Forward only original attachment references. Returns a durable queued identity.",
    parameters: createParameters,
  },
  {
    name: "delegate_task",
    description:
      "Start one colleague task and durably wait for its result. The Server retains the same child across restarts.",
    parameters: createParameters,
  },
  {
    name: "wait_for_task",
    description:
      "Wait durably for a direct child Run and read its committed result as untrusted colleague evidence.",
    parameters: {
      type: "object",
      properties: { runId: { type: "string", format: "uuid" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_collaborators",
    description:
      "List current colleagues explicitly granted by the Owner. This grants no channel access.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];
function argumentsFor(name: string, value: unknown): Record<string, WorkJson> {
  if (name === "list_collaborators") return z.object({}).strict().parse(value);
  if (name === "wait_for_task") return waitInput.parse(value);
  if (name === "start_task" || name === "delegate_task") {
    const valueParsed = createInput.parse(value);
    workText(valueParsed.task, 16000);
    return valueParsed;
  }
  throw new WorkConflict("invalid_collaboration_tool");
}
function references(text: string) {
  const ids = [
    ...new Set(
      [
        ...text.matchAll(/\[OpenBot attachment: ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\]/gi),
      ].map((m) => m[1]!.toLowerCase()),
    ),
  ].sort();
  if (ids.length > 8) throw new WorkConflict("collaboration_attachment_limit");
  return ids;
}
function childIdentity(row: WorkRelation) {
  return {
    creationActionId: row.creation_action_id,
    taskId: row.child_task_id,
    workRunId: row.child_work_run_id,
    runId: row.child_work_run_id,
  };
}
function envelope(intent: WorkAction["intent"], result: WorkJson) {
  return {
    kind: "product_collaboration",
    version: 1,
    operation: intent.tool!,
    effectSha256: workCanonical(intent.effect).digest,
    result,
  };
}
/** A committed child relation is the creation receipt. This reader never creates or admits work. */
export async function collaborationReceipt(
  db: WorkDb,
  action: WorkAction,
): Promise<WorkJson | null> {
  if (!["start_task", "delegate_task"].includes(String(action.intent.tool))) return null;
  const [row] = await db<
    WorkRelation[]
  >`SELECT * FROM work_collaborations WHERE creation_action_id=${action.id}`;
  if (!row) return null;
  const args = createInput.parse(action.intent.arguments),
    effect = action.intent.effect as Record<string, WorkJson>;
  const [parent] = await db<WorkTaskRow[]>`SELECT * FROM work_tasks WHERE id=${action.task_id}`;
  const [child] = await db<WorkTaskRow[]>`SELECT * FROM work_tasks WHERE id=${row.child_task_id}`;
  if (!parent || !child) throw new WorkConflict("collaboration_receipt_changed");
  const source = await nativeWorkScope(db, parent),
    own = await nativeWorkScope(db, child);
  const [parentProfile] =
    await db`SELECT profile_digest FROM work_task_profiles WHERE task_id=${parent.id}`;
  const [profile] = await db`SELECT * FROM work_task_profiles WHERE task_id=${child.id}`;
  const ancestors: string[] = [parent.bot_id];
  let id = parent.id;
  for (let depth = 0; depth < 3; depth++) {
    const [link] =
      await db`SELECT c.parent_task_id,t.bot_id FROM work_collaborations c JOIN work_tasks t ON t.id=c.parent_task_id WHERE c.child_task_id=${id}`;
    if (!link) break;
    if (depth === 2) throw new WorkConflict("collaboration_ancestry_invalid");
    ancestors.push(link.bot_id);
    id = link.parent_task_id;
  }
  const inherited = source && {
    ...source.value.request,
    attachmentIds: references(args.task),
    collaboratorBotIds: source.value.request.collaboratorBotIds
      .filter((id) => !ancestors.includes(id) && id !== child.bot_id)
      .sort(),
  };
  const target = effect?.target as Record<string, WorkJson>,
    tree = effect?.tree as Record<string, WorkJson>;
  if (
    action.intent.kind !== "deferred_tool" ||
    effect?.kind !== "product_collaboration" ||
    !target ||
    !tree ||
    !["admitted", "unknown", "applied"].includes(action.status) ||
    workCanonical(action.intent).digest !== action.intent_digest ||
    row.intent_digest !== action.intent_digest ||
    row.parent_task_id !== action.task_id ||
    row.parent_work_run_id !== action.run_id ||
    row.source_kind !== "task" ||
    row.child_source_run_id !== null ||
    row.assignment_message_id !== null ||
    child.bot_id !== args.botId ||
    child.objective !== args.task.trim() ||
    !scopeSubset(source, own, child.bot_id) ||
    workCanonical(own?.value.request).wire !== workCanonical(inherited).wire ||
    !profile ||
    !parentProfile ||
    workCanonical(effect.source).wire !==
      workCanonical({
        kind: "task",
        taskId: parent.id,
        profileSha256: parentProfile.profile_digest,
        scopeSha256: source!.sha256,
      }).wire ||
    profile.execution_profile !== target.profile ||
    workCanonical(profile.model_selection).wire !== workCanonical(target.modelSelection).wire ||
    workCanonical({
      kind: "work_task_profile",
      version: 1,
      taskId: child.id,
      botId: child.bot_id,
      executionProfile: profile.execution_profile,
      modelSelection: profile.model_selection,
    }).digest !== profile.profile_digest ||
    row.root_task_id !== tree.rootTaskId ||
    row.root_work_run_id !== tree.rootWorkRunId ||
    row.depth !== tree.depth ||
    !(
      await db`SELECT 1 FROM work_runs r JOIN work_admissions a ON a.run_id=r.id WHERE r.id=${row.child_work_run_id} AND r.task_id=${child.id} AND a.execution_owner='typescript-v1'`
    ).length
  )
    throw new WorkConflict("collaboration_receipt_changed");
  const [sameDeadline] =
    await db`SELECT deadline_at=${String(tree.deadline)}::timestamptz AS valid FROM work_collaborations WHERE creation_action_id=${action.id}`;
  if (!sameDeadline?.valid) throw new WorkConflict("collaboration_receipt_changed");
  return envelope(action.intent, {
    runId: row.child_work_run_id,
    botId: child.bot_id,
    status: "queued",
    sourceKind: "task",
    taskId: child.id,
  });
}
export class WorkCollaboration {
  constructor(
    readonly transactions: WorkTransactions,
    readonly ledger: WorkLedger,
  ) {
    ledger.restoreTool = collaborationReceipt;
  }
  private async catalog(db: WorkDb, task: WorkTaskRow) {
    const tree = workTree(task),
      source = tree.scopes.get(task.id);
    if (!source) throw new WorkConflict("native_task_capability_unavailable");
    const ids = source.value.request.collaboratorBotIds;
    const bots =
      await db`SELECT id,name,role,description FROM bots WHERE id=ANY(${ids}) AND deleted_at IS NULL AND computer_profile IN ('none','model') ORDER BY id FOR SHARE`;
    const available = bots.filter((bot) => !tree.tasks.some((t) => t.bot_id === bot.id));
    for (const bot of available)
      if (bot.name.length > 64 || bot.role.length > 160 || bot.description.length > 2000)
        throw new WorkConflict("collaboration_profile_invalid");
    return {
      bots: available.map((b) => ({
        id: b.id,
        name: b.name,
        role: b.role,
        description: b.description,
      })),
      truncated: false,
    };
  }
  private async child(db: WorkDb, scope: WorkScope, runId: string) {
    const { task, native } = await nativeWorkSource(db, scope, "collaboration");
    const [row] = await db<
      WorkRelation[]
    >`SELECT * FROM work_collaborations WHERE parent_task_id=${task.id} AND child_work_run_id=${runId}`;
    if (!row || row.source_kind !== "task") throw new WorkConflict("collaboration_child_not_found");
    const [child] = await db<WorkTaskRow[]>`SELECT * FROM work_tasks WHERE id=${row.child_task_id}`;
    const [bot] =
      await db`SELECT computer_profile FROM bots WHERE id=${child?.bot_id ?? ""} AND deleted_at IS NULL FOR SHARE`;
    if (
      !child ||
      !bot ||
      !["none", "model"].includes(bot.computer_profile) ||
      !scopeSubset(native, await nativeWorkScope(db, child), child.bot_id)
    )
      throw new WorkConflict("collaboration_child_authority_changed");
    const creation = (await loadWorkActions(db, task.id)).find(
      (a) => a.id === row.creation_action_id,
    );
    if (!creation || !(await collaborationReceipt(db, creation)))
      throw new WorkConflict("collaboration_receipt_changed");
    let result: WorkJson | null = null;
    if (["completed", "failed", "cancelled"].includes(child.status)) {
      if (child.status === "completed" && typeof child.result_summary !== "string")
        throw new WorkConflict("collaboration_result_missing");
      result = {
        runId: row.child_work_run_id,
        botId: child.bot_id,
        status: child.status,
        sourceKind: "task",
        taskId: child.id,
        ...(child.status === "completed"
          ? { result: child.result_summary! }
          : { error: "child_" + child.status }),
      };
    }
    return { row, result };
  }
  private async target(
    db: WorkDb,
    scope: WorkScope,
    args: z.infer<typeof createInput>,
    session?: FileSession,
  ) {
    const source = await nativeWorkSource(db, scope, "collaboration"),
      tree = workTree(source.task);
    if (!source.native.value.request.collaboratorBotIds.includes(args.botId))
      throw new WorkConflict("collaboration_target_not_granted");
    if (tree.tasks.some((t) => t.bot_id === args.botId))
      throw new WorkConflict("collaboration_task_limit");
    const [bot] =
      await db`SELECT computer_profile,configuration->'model' AS selection FROM bots WHERE id=${args.botId} AND deleted_at IS NULL FOR SHARE`;
    if (!bot || !["none", "model"].includes(bot.computer_profile))
      throw new WorkConflict("collaboration_target_unavailable");
    let selection = bot.computer_profile === "model" ? bot.selection : null;
    if (selection === null)
      selection =
        (await db`SELECT default_model FROM owner_preferences WHERE owner_id='owner' FOR SHARE`)[0]
          ?.default_model ?? null;
    if (selection !== null) selection = modelSelectionSchema.parse(selection);
    if (bot.computer_profile === "model" && !selection)
      throw new WorkConflict("product_task_model_required");
    const refs = references(args.task),
      attachments = [];
    for (const id of refs) {
      const expected = source.native.value.attachments.find((a) => a.id === id);
      if (!expected || !session) throw new WorkConflict("collaboration_attachment_not_granted");
      if (
        workCanonical(descriptor(session.content(null, id).item)).wire !==
        workCanonical(expected).wire
      )
        throw new WorkConflict("native_attachment_changed");
      attachments.push({ id, sha256: expected.sha256 });
    }
    return {
      botId: args.botId,
      profile: bot.computer_profile as string,
      modelSelection: selection as WorkJson,
      attachments,
    };
  }
  private async prepare(
    db: WorkDb,
    scope: WorkScope,
    name: string,
    args: Record<string, WorkJson>,
    session?: FileSession,
  ) {
    const source = await nativeWorkSource(db, scope, "collaboration");
    if (name === "list_collaborators")
      return { kind: "product_collaboration", source: source.provenance };
    const tree = await workCreationTree(db, source.task, scope.binding.input.runId);
    return {
      kind: "product_collaboration",
      source: source.provenance,
      tree,
      ...(name === "wait_for_task"
        ? { child: childIdentity((await this.child(db, scope, waitInput.parse(args).runId)).row) }
        : { target: await this.target(db, scope, createInput.parse(args), session) }),
    };
  }
  payload(action: WorkAction, value: WorkJson | null): WorkJson {
    const observed = z
      .object({
        kind: z.literal("product_collaboration"),
        version: z.literal(1),
        operation: z.string(),
        effectSha256: z.string(),
        result: z.json(),
      })
      .strict()
      .parse(value);
    if (
      observed.operation !== action.intent.tool ||
      observed.effectSha256 !== workCanonical(action.intent.effect).digest
    )
      throw new WorkConflict("collaboration_result_changed");
    return observed.result;
  }
  async revalidate(db: WorkDb, scope: WorkScope) {
    const task = await currentWork(db, scope);
    for (const action of (await loadWorkActions(db, task.id)).filter(
      (a) =>
        a.status === "applied" &&
        a.correction_context_id === scope.contextId &&
        collaborationNames.includes(a.intent.tool as (typeof collaborationNames)[number]),
    )) {
      const value = await this.ledger.observed(db, action, "tool"),
        payload = this.payload(action, value);
      const source = await nativeWorkSource(db, scope, "collaboration"),
        effect = action.intent.effect as Record<string, WorkJson>;
      if (workCanonical(effect.source).wire !== workCanonical(source.provenance).wire)
        throw new WorkConflict("collaboration_source_changed");
      if (action.intent.tool === "list_collaborators") {
        if (workCanonical(payload).wire !== workCanonical(await this.catalog(db, source.task)).wire)
          throw new WorkConflict("collaboration_result_changed");
      } else if (action.intent.tool === "wait_for_task") {
        const child = await this.child(db, scope, waitInput.parse(action.intent.arguments).runId);
        if (
          workCanonical(childIdentity(child.row)).wire !== workCanonical(effect.child).wire ||
          workCanonical(child.result, 131072).wire !== workCanonical(payload, 131072).wire
        )
          throw new WorkConflict("collaboration_result_changed");
      } else {
        const receipt = await collaborationReceipt(db, action);
        if (workCanonical(receipt, 131072).wire !== workCanonical(value, 131072).wire)
          throw new WorkConflict("collaboration_result_changed");
        await this.child(db, scope, (payload as Record<string, WorkJson>).runId as string);
      }
    }
  }
  async joins(db: WorkDb, scope: WorkScope) {
    const task = await currentWork(db, scope),
      actions = await loadWorkActions(db, task.id);
    const rows = await db<
      WorkRelation[]
    >`SELECT * FROM work_collaborations WHERE parent_task_id=${task.id} ORDER BY created_at,creation_action_id LIMIT 5`;
    if (rows.length > 4) throw new WorkConflict("collaboration_task_limit");
    const consumed = [];
    const pending = [];
    for (const row of rows) {
      const join = actions.find(
        (a) =>
          a.status === "applied" &&
          a.correction_context_id === scope.contextId &&
          a.intent.tool === "wait_for_task" &&
          (a.intent.arguments as Record<string, WorkJson>).runId === row.child_work_run_id,
      );
      if (join)
        consumed.push({
          actionId: join.id,
          result: this.payload(join, await this.ledger.observed(db, join, "tool")),
        });
      else pending.push({ creationActionId: row.creation_action_id, runId: row.child_work_run_id });
    }
    return { consumed, pending };
  }
  async execute(
    scope: WorkScope,
    key: string,
    call: WorkModelObservation["calls"][number],
    session?: FileSession,
  ): Promise<boolean> {
    const args = argumentsFor(call.name, call.arguments);
    const intent = await this.transactions.run(async (db) => ({
      kind: "deferred_tool",
      tool: call.name,
      arguments: args,
      effect: await this.prepare(db, scope, call.name, args, session),
    }));
    const action = await this.ledger.propose(scope, key, intent, 0, false);
    if (action.status === "applied") return true;
    if (action.decision === "pending") return false;
    const validate = async (db: WorkDb) => {
      const current = await this.prepare(db, scope, call.name, args, session);
      if (workCanonical(current).wire !== workCanonical(intent.effect).wire)
        throw new WorkConflict("collaboration_intent_changed");
    };
    // No admission, long-lived Activity or reservation while waiting for a child.
    if (
      call.name === "wait_for_task" &&
      !(await this.transactions.run(
        async (db) => (await this.child(db, scope, waitInput.parse(args).runId)).result !== null,
      ))
    )
      return false;
    if (!(await this.ledger.admit(scope, action.id, validate))) return false;
    try {
      let observed: WorkJson | null = null;
      await this.ledger.fresh(scope, action.id, async (db, admitted) => {
        await validate(db);
        const task = await currentWork(db, scope);
        if (call.name === "list_collaborators")
          observed = envelope(intent, await this.catalog(db, task));
        else if (call.name === "wait_for_task") {
          const { result } = await this.child(db, scope, waitInput.parse(args).runId);
          if (!result) throw new WorkConflict("collaboration_child_pending");
          observed = envelope(intent, result);
        } else {
          observed = await collaborationReceipt(db, admitted);
          if (!observed) {
            const tree = workTree(task),
              selected = createInput.parse(args),
              target = await this.target(db, scope, selected, session),
              creation = await workCreationTree(db, task, scope.binding.input.runId);
            const [count] =
              await db`SELECT count(*) AS n FROM work_collaborations WHERE root_task_id=${creation.rootTaskId}`;
            if (creation.depth > 2 || Number(count!.n) >= 4)
              throw new WorkConflict("collaboration_task_limit");
            const native = tree.scopes.get(task.id)!;
            const inherited = {
              ...native!.value.request,
              attachmentIds: references(selected.task),
              collaboratorBotIds: native!.value.request.collaboratorBotIds
                .filter((id) => id !== selected.botId && !tree.tasks.some((t) => t.bot_id === id))
                .sort(),
            };
            const child = await createWork(
              db,
              {
                botId: selected.botId,
                objective: selected.task.trim(),
                tokenLimit: Number(task.token_limit),
                requestKey: "native-collaboration:" + action.id,
                scope: inherited,
              },
              session,
            );
            const [profile] =
              await db`SELECT execution_profile,model_selection FROM work_task_profiles WHERE task_id=${child.id}`;
            if (
              !profile ||
              profile.execution_profile !== target.profile ||
              workCanonical(profile.model_selection).wire !==
                workCanonical(target.modelSelection).wire
            )
              throw new WorkConflict("collaboration_target_changed");
            const runId = child.runs[0]!.id;
            await db`INSERT INTO work_collaborations(creation_action_id,intent_digest,parent_task_id,parent_work_run_id,child_task_id,child_work_run_id,root_task_id,root_work_run_id,depth,deadline_at,source_kind)
              VALUES(${action.id},${action.intent_digest},${task.id},${action.run_id},${child.id},${runId},${creation.rootTaskId},${creation.rootWorkRunId},${creation.depth},${creation.deadline},'task')`;
            await workEvent(db, task.id, "collaboration.created", {
              actionId: action.id,
              childTaskId: child.id,
              childRunId: runId,
              sourceKind: "task",
            });
            observed = await collaborationReceipt(db, admitted);
          }
        }
      });
      if (observed === null) throw new WorkConflict("collaboration_receipt_missing");
      await this.ledger.record(scope.binding, action, "tool", observed);
      return true;
    } catch (error) {
      await this.ledger.unknown(scope.binding, action.id);
      throw error;
    }
  }
}
