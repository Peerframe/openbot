import { WorkConflict } from "@openbot/work";
import type { WorkDb, WorkTaskRow } from "./work-handoff.js";
import { workEvent } from "./work-handoff.js";
import { nativeWorkScope } from "./work-scope.js";
import { workCanonical } from "./work-values.js";

export type WorkRelation = {
  creation_action_id: string;
  intent_digest: string;
  parent_task_id: string;
  parent_work_run_id: string;
  child_task_id: string;
  child_work_run_id: string;
  child_source_run_id: string | null;
  root_task_id: string;
  root_work_run_id: string;
  assignment_message_id: string | null;
  depth: number;
  deadline_at: Date;
  source_kind: string;
};
type NativeScope = Awaited<ReturnType<typeof nativeWorkScope>>;
export type WorkTree = {
  tasks: WorkTaskRow[];
  links: WorkRelation[];
  scopes: Map<string, NativeScope>;
  rootTaskId: string;
  rootWorkRunId: string | null;
  deadline: string | null;
  live: boolean;
  members: boolean;
};
const facts = new WeakMap<WorkTaskRow, WorkTree>();
export function workTree(task: WorkTaskRow): WorkTree {
  const value = facts.get(task);
  if (!value) throw new WorkConflict("collaboration_lock_required");
  return value;
}
export function scopeSubset(parent: NativeScope, child: NativeScope, botId: string) {
  if (!parent || !child) return false;
  const a = parent.value.request,
    b = child.value.request;
  return (
    a.collaboratorBotIds.includes(botId) &&
    !b.collaboratorBotIds.includes(botId) &&
    b.collaboratorBotIds.every((id) => a.collaboratorBotIds.includes(id)) &&
    b.attachmentIds.every((id) => a.attachmentIds.includes(id)) &&
    (["knowledge", "plugins", "web"] as const).every((key) => !b[key] || a[key]) &&
    workCanonical(child.value.attachments).wire ===
      workCanonical(parent.value.attachments.filter((a) => b.attachmentIds.includes(a.id))).wire
  );
}
async function linksFor(db: WorkDb, id: string) {
  const links: WorkRelation[] = [],
    seen = new Set([id]);
  for (;;) {
    const [row] = await db<
      WorkRelation[]
    >`SELECT * FROM work_collaborations WHERE child_task_id=${id}`;
    if (!row) return links.reverse();
    if (links.length >= 2 || seen.has(row.parent_task_id))
      throw new WorkConflict("collaboration_ancestry_invalid");
    links.push(row);
    id = row.parent_task_id;
    seen.add(id);
  }
}
export async function rootWorkDeadline(db: WorkDb, taskId: string, runId: string) {
  const [row] =
    await db`SELECT payload,to_char(created_at+interval '300 seconds','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline FROM work_events
    WHERE task_id=${taskId} AND kind='run.claimed' AND payload->>'runId'=${runId} ORDER BY created_at,revision LIMIT 1`;
  if (
    !row ||
    Object.keys(row.payload).sort().join(",") !== "epoch,runId" ||
    !Number.isInteger(row.payload.epoch) ||
    row.payload.epoch < 1 ||
    row.payload.epoch > 10000
  )
    throw new WorkConflict("collaboration_root_claim_required");
  return row.deadline as string;
}
/** Same root advisory lock as Python covers first child creation, cancel and every descendant write. */
export async function lockWorkTree(db: WorkDb, taskId: string): Promise<WorkTaskRow> {
  const links = await linksFor(db, taskId);
  const ids = links.length
    ? [links[0]!.root_task_id, ...links.map((l) => l.child_task_id)]
    : [taskId];
  if (links.length && (links[0]!.parent_task_id !== ids[0] || ids.at(-1) !== taskId))
    throw new WorkConflict("collaboration_ancestry_invalid");
  // Channel source locking is installed with the channel admission adapter, never simulated here.
  if ((await db`SELECT 1 FROM work_sources WHERE task_id=${ids[0]!}`).length)
    throw new WorkConflict("work_channel_not_migrated");
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${"native-task:" + ids[0]},731))`;
  const tasks: WorkTaskRow[] = [],
    scopes = new Map<string, NativeScope>();
  for (const id of ids) {
    const [task] = await db<WorkTaskRow[]>`SELECT * FROM work_tasks WHERE id=${id} FOR UPDATE`;
    if (!task) throw new WorkConflict("work_not_found");
    tasks.push(task);
    scopes.set(id, await nativeWorkScope(db, task));
  }
  if (JSON.stringify(await linksFor(db, taskId)) !== JSON.stringify(links))
    throw new WorkConflict("collaboration_ancestry_changed");
  for (const [index, link] of links.entries()) {
    if (
      link.source_kind !== "task" ||
      link.depth !== index + 1 ||
      link.root_task_id !== ids[0] ||
      link.parent_task_id !== ids[index] ||
      link.child_source_run_id !== null ||
      link.assignment_message_id !== null ||
      !scopeSubset(scopes.get(ids[index]!)!, scopes.get(ids[index + 1]!)!, tasks[index + 1]!.bot_id)
    )
      throw new WorkConflict("collaboration_ancestry_invalid");
    for (const [task, run] of [
      [link.parent_task_id, link.parent_work_run_id],
      [link.child_task_id, link.child_work_run_id],
    ])
      if (!(await db`SELECT 1 FROM work_runs WHERE task_id=${task!} AND id=${run!}`).length)
        throw new WorkConflict("collaboration_ancestry_invalid");
  }
  const tree =
    links[0] ??
    (
      await db<
        WorkRelation[]
      >`SELECT * FROM work_collaborations WHERE root_task_id=${taskId} ORDER BY created_at,creation_action_id LIMIT 1`
    )[0];
  const deadline = tree ? await rootWorkDeadline(db, ids[0]!, tree.root_work_run_id) : null;
  let members = true;
  if (tree) {
    if (
      [...links, tree].some(
        (l) => l.source_kind !== "task" || l.root_work_run_id !== tree.root_work_run_id,
      )
    )
      throw new WorkConflict("collaboration_deadline_changed");
    for (const link of [...links, tree]) {
      const [same] =
        await db`SELECT deadline_at=${deadline!}::timestamptz AS valid FROM work_collaborations WHERE creation_action_id=${link.creation_action_id}`;
      if (!same?.valid) throw new WorkConflict("collaboration_deadline_changed");
    }
    for (const task of tasks) {
      const [bot] =
        await db`SELECT computer_profile FROM bots WHERE id=${task.bot_id} AND deleted_at IS NULL FOR SHARE`;
      const [profile] =
        await db`SELECT * FROM work_task_profiles WHERE task_id=${task.id} FOR SHARE`;
      if (
        !profile ||
        profile.bot_id !== task.bot_id ||
        !["none", "model"].includes(profile.execution_profile) ||
        workCanonical({
          kind: "work_task_profile",
          version: 1,
          taskId: task.id,
          botId: task.bot_id,
          executionProfile: profile.execution_profile,
          modelSelection: profile.model_selection,
        }).digest !== profile.profile_digest
      )
        throw new WorkConflict("collaboration_source_changed");
      members &&= !!bot && ["none", "model"].includes(bot.computer_profile);
    }
  }
  const [clock] = deadline
    ? await db`SELECT clock_timestamp()<${deadline}::timestamptz AS live`
    : [{ live: true }];
  const task = tasks.at(-1)!;
  facts.set(task, {
    tasks: tasks.map((t) => ({ ...t })),
    links,
    scopes,
    rootTaskId: ids[0]!,
    rootWorkRunId: tree?.root_work_run_id ?? null,
    deadline,
    live: clock!.live,
    members,
  });
  return task;
}
export function activeWorkTree(task: WorkTaskRow) {
  const tree = workTree(task);
  if (!tree.live || !tree.members) throw new WorkConflict("collaboration_authority_closed");
  if (
    tree.tasks.some(
      (t) => !t.authority_active || t.cancel_requested || !["queued", "open"].includes(t.status),
    )
  )
    throw new WorkConflict("collaboration_ancestor_closed");
}
export async function workCreationTree(db: WorkDb, task: WorkTaskRow, runId: string) {
  activeWorkTree(task);
  const tree = workTree(task),
    rootRun = tree.rootWorkRunId ?? runId;
  if (!tree.links.length && rootRun !== runId)
    throw new WorkConflict("collaboration_root_run_changed");
  const deadline = await rootWorkDeadline(db, tree.rootTaskId, rootRun);
  const [clock] = await db`SELECT clock_timestamp()<${deadline}::timestamptz AS live`;
  if (!clock?.live) throw new WorkConflict("collaboration_deadline_expired");
  return {
    rootTaskId: tree.rootTaskId,
    rootWorkRunId: rootRun,
    deadline,
    depth: tree.links.length + 1,
  };
}
/** Retain unknown reservations; closing authority never implies an effect did not happen. */
export async function cascadeWork(
  db: WorkDb,
  taskId: string,
  reason: "cancel" | "revoke" | "expired" | "failed",
  includeSelf = true,
) {
  const task = await lockWorkTree(db, taskId),
    tree = workTree(task);
  const rows = await db<
    WorkRelation[]
  >`SELECT * FROM work_collaborations WHERE root_task_id=${tree.rootTaskId} ORDER BY depth,child_task_id LIMIT 5`;
  if (rows.length > 4) throw new WorkConflict("collaboration_task_limit");
  const selected = new Set([taskId]),
    order = includeSelf ? [taskId] : [];
  for (const row of rows)
    if (selected.has(row.parent_task_id)) {
      selected.add(row.child_task_id);
      order.push(row.child_task_id);
    }
  for (const id of order) {
    const current = await lockWorkTree(db, id),
      cancel = reason !== "revoke";
    if (
      !["queued", "open"].includes(current.status) ||
      (!current.authority_active && (!cancel || current.cancel_requested))
    )
      continue;
    await db`UPDATE work_tasks SET authority_active=false,authority_generation=authority_generation+1,cancel_requested=cancel_requested OR ${cancel} WHERE id=${id}`;
    const pending =
      await db`SELECT 1 FROM work_actions WHERE task_id=${id} AND status IN ('admitted','unknown') LIMIT 1`;
    if (cancel && !pending.length) {
      await db`UPDATE work_tasks SET status='cancelled' WHERE id=${id}`;
      await db`UPDATE work_runs SET status='cancelled' WHERE task_id=${id} AND status IN ('queued','running')`;
    }
    await workEvent(db, id, cancel ? "task.cancel_requested" : "task.authority_revoked", {
      collaborationReason: reason,
    });
  }
}
export async function workTreeBudget(db: WorkDb, task: WorkTaskRow) {
  const tree = workTree(task),
    root = tree.tasks[0]!;
  const [usage] =
    await db`SELECT coalesce(sum(a.reserved_tokens) FILTER (WHERE a.status IN ('admitted','unknown')),0) AS reserved,
    coalesce(sum(a.actual_tokens),0) AS spent FROM work_actions a WHERE a.task_id=${root.id}
    OR a.task_id IN (SELECT child_task_id FROM work_collaborations WHERE root_task_id=${root.id})`;
  return {
    limit: Number(root.token_limit),
    reserved: Number(usage!.reserved),
    spent: Number(usage!.spent),
  };
}
