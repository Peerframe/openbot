import { workspaceSnapshotSchema } from "@openbot/protocol";
import type postgres from "postgres";
import {
  botProjection,
  channelProjection,
  runProjection,
  boundedProjection,
} from "./channel-read-projection.js";
import { botsQuery, channelsQuery } from "./channel-read-query.js";
import { employeeRows, employeeTime } from "./employee-records.js";
import { progressSummaries } from "./run-progress.js";
import { refuse } from "./owner-transaction.js";
import type {
  ProductRoute,
  AuthorizedProductOperation,
  ProductRequest,
} from "./product-identity.js";
import type { RuntimeSnapshot } from "./runtime-port.js";

export async function workspaceSnapshot(db: postgres.TransactionSql, runtime: RuntimeSnapshot) {
  // The same repeatable-read snapshot covers preferences, relationships and counts. No
  // preference row lock: a concurrent writer must not turn a consistent display into 40001.
  const [settings] =
    await db`SELECT primary_bot_id,revision FROM workspace_settings WHERE workspace_id='workspace'`;
  if (!settings) return refuse(503, "workspace_settings_unavailable");
  const bots = await db.unsafe(botsQuery),
    channels = await db.unsafe(channelsQuery);
  if (bots.length > 1000 || channels.length > 10000)
    return refuse(503, "workspace_projection_limit");
  const records = await employeeRows(
    db,
    `SELECT p.* FROM (SELECT id FROM runs ORDER BY created_at DESC,id DESC LIMIT 50) r JOIN runs_work_projection p ON p.id=r.id ORDER BY p.created_at DESC,p.id DESC`,
  );
  const runProgress = await progressSummaries(db, records);
  const approvals = await employeeRows(
    db,
    "SELECT a.*,r.channel_id,r.bot_id FROM approvals a JOIN runs r ON r.id=a.run_id ORDER BY a.created_at DESC,a.id LIMIT 100",
  );
  const artifacts = await employeeRows(
    db,
    "SELECT * FROM artifacts ORDER BY created_at DESC,id LIMIT 100",
  );
  const progress = await employeeRows(
    db,
    "SELECT id,run_id,channel_id,node_id,payload,created_at FROM run_events WHERE type='RUN_PROGRESS' ORDER BY created_at DESC,id LIMIT 200",
  );
  const [counts] =
    await db`SELECT (SELECT count(*) FROM channels WHERE deleted_at IS NULL) AS channels,(SELECT count(*) FROM bots WHERE deleted_at IS NULL) AS bots,(SELECT count(*) FROM runs_work_projection WHERE status IN ('queued','assigned','running','waiting_approval','blocked')) AS active_runs`;
  return boundedProjection(
    workspaceSnapshotSchema.parse({
      primaryBotId: settings.primary_bot_id,
      revision: settings.revision,
      bots: bots.map(botProjection),
      channels: channelProjection(channels),
      nodes: runtime.nodes,
      runs: records.map((row) =>
        runProjection({
          ...row,
          created_at: new Date(row.created_at),
          updated_at: new Date(row.updated_at),
        }),
      ),
      runProgress,
      approvals: approvals.map((row) => ({
        ...Object.fromEntries(
          [
            ["id", "id"],
            ["runId", "run_id"],
            ["channelId", "channel_id"],
            ["botId", "bot_id"],
            ["nodeId", "node_id"],
            ["action", "action"],
            ["target", "target"],
            ["summary", "summary"],
            ["risk", "risk"],
            ["targetFingerprint", "target_fingerprint"],
            ["beforeState", "before_state"],
            ["status", "status"],
          ].map(([out, key]) => [out, row[key!]]),
        ),
        ...Object.fromEntries(
          [
            ["createdAt", "created_at"],
            ["expiresAt", "expires_at"],
            ["decidedAt", "decided_at"],
          ]
            .filter(([, key]) => row[key!] != null)
            .map(([out, key]) => [out, employeeTime(row[key!])]),
        ),
        ...(row.decided_by != null ? { decidedBy: row.decided_by } : {}),
      })),
      artifacts: artifacts.map((row) => ({
        id: row.id,
        runId: row.run_id,
        name: row.name,
        mediaType: row.media_type,
        sha256: row.sha256,
        sizeBytes: row.metadata?.sizeBytes ?? 0,
        createdAt: employeeTime(row.created_at),
      })),
      progress: progress
        .reverse()
        .filter(
          (row) =>
            row.run_id &&
            row.channel_id &&
            typeof row.payload?.stage === "string" &&
            typeof row.payload?.message === "string",
        )
        .map((row) => ({
          id: row.id,
          runId: row.run_id,
          channelId: row.channel_id,
          stage: row.payload.stage,
          message: row.payload.message,
          createdAt: employeeTime(row.created_at),
          ...(row.node_id ? { nodeId: row.node_id } : {}),
        })),
      counts: {
        channels: Number(counts!.channels),
        bots: Number(counts!.bots),
        activeRuns: Number(counts!.active_runs),
        connectedNodes: runtime.nodes.length,
      },
    }),
  );
}
export async function readWorkspace(
  owner: AuthorizedProductOperation,
  request: ProductRequest,
  signal: AbortSignal,
) {
  if (!request.runtime) return refuse(503, "worker_runtime_unavailable");
  const runtime = await request.runtime.snapshot(signal);
  const snapshot = await owner((db) => workspaceSnapshot(db, runtime), signal, "repeatable read");
  return { snapshot, runtimeRevision: runtime.revision };
}
export const workspaceRoutes: ProductRoute[] = ["/api/v1/workspace", "/api/v1/bootstrap"].map(
  (path) => ({
    method: "GET",
    path,
    kind: "product",
    execute: async () => {
      throw new Error("Live runtime metadata required.");
    },
    remote: async (owner, _ids, _body, signal, request) => {
      const { snapshot } = await readWorkspace(owner, request, signal);
      return path.endsWith("bootstrap")
        ? { project: "openbot", phase: "m1", counts: snapshot.counts }
        : snapshot;
    },
  }),
);
