import { randomUUID } from "node:crypto";
import { WorkConflict } from "@openbot/work";
import { admitChannelWork, channelAudit, taskTitle } from "./work-channel.js";
import type { WorkDb, WorkTaskRow } from "./work-handoff.js";
import { workEvent } from "./work-handoff.js";
import type { WorkAction } from "./work-ledger.js";
import { channelWorkRow, workTree, type WorkRelation, type workCreationTree } from "./work-tree.js";
import { workAttachmentIds } from "./work-source.js";
import { sha256, workCanonical, type WorkJson } from "./work-values.js";
/** Immutable SQL receipt recovery: no membership grant, execution, or second child creation. */
export async function channelCollaborationReceipt(
  db: WorkDb,
  action: WorkAction,
  row: WorkRelation,
) {
  const args = action.intent.arguments as { botId: string; task: string },
    effect = action.intent.effect as Record<string, WorkJson>,
    target = effect.target as Record<string, WorkJson>,
    tree = effect.tree as Record<string, WorkJson>;
  const parent = await channelWorkRow(db, row.parent_task_id),
    child = await channelWorkRow(db, row.child_task_id),
    root = await channelWorkRow(db, row.root_task_id);
  const [p] = await db`SELECT bot_id,objective FROM work_tasks WHERE id=${action.task_id}`;
  const [t] = await db`SELECT bot_id,objective FROM work_tasks WHERE id=${row.child_task_id}`;
  const [m] =
    await db`SELECT author_type,author_id,content,reply_to_message_id FROM messages WHERE id=${row.assignment_message_id!}`;
  if (!parent || !child || !root || !p || !t || !m || !target || !tree)
    throw new WorkConflict("collaboration_receipt_changed");
  const source = {
    kind: "channel",
    taskId: action.task_id,
    sourceRunId: parent.legacy_run_id,
    channelId: parent.channel_id,
    messageId: parent.source_message_id,
    messageCutoff: root.message_cutoff,
    runCutoff: root.run_cutoff,
    replyTo: parent.reply_to_message_id,
    instructionSha256: sha256(p.objective),
  };
  if (
    action.intent.kind !== "deferred_tool" ||
    effect.kind !== "product_collaboration" ||
    workCanonical(action.intent).digest !== action.intent_digest ||
    !["admitted", "unknown", "applied"].includes(action.status) ||
    row.intent_digest !== action.intent_digest ||
    row.source_kind !== "channel" ||
    row.parent_task_id !== action.task_id ||
    row.parent_work_run_id !== action.run_id ||
    child.legacy_run_id !== row.child_source_run_id ||
    child.source_message_id !== row.assignment_message_id ||
    child.bot_id !== args.botId ||
    t.bot_id !== args.botId ||
    child.instruction !== args.task.trim() ||
    t.objective !== child.instruction ||
    m.content !== child.instruction ||
    m.author_type !== "bot" ||
    m.author_id !== p.bot_id ||
    m.reply_to_message_id !== parent.source_message_id ||
    child.channel_id !== parent.channel_id ||
    child.run_channel !== parent.channel_id ||
    child.message_channel !== parent.channel_id ||
    child.run_message !== child.source_message_id ||
    child.parent_run_id !== parent.legacy_run_id ||
    child.root_run_id !== root.legacy_run_id ||
    child.delegated_by_bot_id !== p.bot_id ||
    child.node_id !== null ||
    child.execution_profile !== target.profile ||
    workCanonical(child.model_selection).wire !== workCanonical(target.modelSelection).wire ||
    workCanonical(effect.source).wire !== workCanonical(source).wire ||
    row.root_task_id !== tree.rootTaskId ||
    row.root_work_run_id !== tree.rootWorkRunId ||
    row.depth !== tree.depth ||
    workAttachmentIds(child.instruction).some(
      (id) => !workAttachmentIds(p.objective).includes(id),
    ) ||
    !(
      await db`SELECT 1 FROM work_runs r JOIN work_admissions a ON a.run_id=r.id WHERE r.id=${row.child_work_run_id} AND r.task_id=${row.child_task_id} AND a.execution_owner='typescript-v1'`
    ).length
  )
    throw new WorkConflict("collaboration_receipt_changed");
  const [deadline] =
    await db`SELECT deadline_at=${String(tree.deadline)}::timestamptz AS valid FROM work_collaborations WHERE creation_action_id=${action.id}`;
  if (!deadline?.valid) throw new WorkConflict("collaboration_receipt_changed");
  return { runId: child.legacy_run_id, botId: child.bot_id, status: "queued" };
}
export async function createChannelChild(
  db: WorkDb,
  task: WorkTaskRow,
  action: WorkAction,
  selected: { botId: string; task: string },
  target: { profile: string; modelSelection: WorkJson },
  creation: Awaited<ReturnType<typeof workCreationTree>>,
) {
  const tree = workTree(task),
    parent = tree.sources.get(task.id)!,
    root = tree.sources.get(tree.rootTaskId)!;
  if (!parent || !root) throw new WorkConflict("collaboration_source_changed");
  const messageId = randomUUID(),
    runId = randomUUID(),
    assignment = selected.task.trim();
  await db`INSERT INTO messages(id,channel_id,author_type,author_id,reply_to_message_id,content)
    VALUES(${messageId},${parent.channel_id},'bot',${task.bot_id},${parent.source_message_id},${assignment})`;
  const [run] =
    await db`INSERT INTO runs(id,channel_id,bot_id,source_message_id,execution_profile,instruction,title,status,parent_run_id,root_run_id,delegated_by_bot_id,model_selection)
    VALUES(${runId},${parent.channel_id},${selected.botId},${messageId},${target.profile},${assignment},${taskTitle(assignment)},'queued',${parent.legacy_run_id},${root.legacy_run_id},${task.bot_id},${target.modelSelection === null ? null : db.json(target.modelSelection)}) RETURNING *`;
  const child = await admitChannelWork(db, run!, Number(task.token_limit));
  await db`INSERT INTO work_collaborations(creation_action_id,intent_digest,parent_task_id,parent_work_run_id,child_task_id,child_work_run_id,child_source_run_id,root_task_id,root_work_run_id,assignment_message_id,depth,deadline_at,source_kind)
    VALUES(${action.id},${action.intent_digest},${task.id},${action.run_id},${child.id},${child.runs[0]!.id},${runId},${creation.rootTaskId},${creation.rootWorkRunId},${messageId},${creation.depth},${creation.deadline},'channel')`;
  await workEvent(db, task.id, "collaboration.created", {
    actionId: action.id,
    childTaskId: child.id,
    childRunId: runId,
  });
  await channelAudit(
    db,
    { id: parent.legacy_run_id, channel_id: parent.channel_id, bot_id: task.bot_id },
    "TASK_DELEGATED",
    { childRunId: runId, targetBotId: selected.botId },
  );
  await channelAudit(db, run!, "RUN_CREATED", {
    sourceMessageId: messageId,
    executionProfile: target.profile,
  });
  await channelAudit(db, { ...run, bot_id: task.bot_id }, "MESSAGE_CREATED", {
    messageId,
    kind: "delegation",
  });
}
