import type {
  Approval,
  Artifact,
  Bot,
  Channel,
  ExecutionNode,
  Run,
  RunProgress,
  WorkspaceSnapshot,
} from "@openbot/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkspace } from "./api";
import {
  mergeArtifacts,
  mergeNodes,
  mergeProgress,
  mergeRuns,
  projectRunOnNodes,
} from "./run-state";

type Projection =
  | { type: "channel"; channel: Channel }
  | { type: "bot"; bot: Bot }
  | { type: "nodes"; nodes: ExecutionNode[] }
  | { type: "node"; node: ExecutionNode }
  | { type: "node-removed"; id: string }
  | { type: "run"; run: Run }
  | { type: "artifact"; artifact: Artifact }
  | { type: "progress"; progress: RunProgress }
  | { type: "approval"; approval: Approval };

type PendingRead = {
  generation: number;
  controller: AbortController;
  projections: Map<string, Projection>;
};

export function useWorkspaceState(onError: (message: string | undefined) => void) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>();
  const generation = useRef(0);
  const pending = useRef<PendingRead | undefined>(undefined);
  const mounted = useRef(false);
  const reconcileNeeded = useRef(false);
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastReadStartedAt = useRef(Number.NEGATIVE_INFINITY);

  const scheduleReconciliation = useCallback((read: () => Promise<void>) => {
    if (!mounted.current || pending.current || reconcileTimer.current !== undefined) return;
    // One dirty bit and timer coalesce both streams without cancelling a useful in-flight read.
    const delay = Math.max(0, 1000 - (Date.now() - lastReadStartedAt.current));
    reconcileTimer.current = setTimeout(() => {
      reconcileTimer.current = undefined;
      if (mounted.current && reconcileNeeded.current && !pending.current) void read();
    }, delay);
  }, []);

  const project = useCallback((projection: Projection) => {
    if (!mounted.current) return;
    const journal = pending.current?.projections;
    if (journal) recordProjection(journal, projection);
    setWorkspace((current) =>
      current === undefined ? current : applyProjection(current, projection),
    );
  }, []);

  const refresh = useCallback(
    async function readWorkspace() {
      if (!mounted.current) return;
      if (reconcileTimer.current !== undefined) clearTimeout(reconcileTimer.current);
      reconcileTimer.current = undefined;
      reconcileNeeded.current = false;
      lastReadStartedAt.current = Date.now();
      pending.current?.controller.abort();
      pending.current?.projections.clear();
      const request: PendingRead = {
        generation: ++generation.current,
        controller: new AbortController(),
        projections: new Map(),
      };
      pending.current = request;
      let succeeded = false;
      onError(undefined);
      try {
        const snapshot = await getWorkspace(request.controller.signal);
        if (request.generation !== generation.current || request.controller.signal.aborted) return;
        // Entity events retain their immediate projections. The global active count comes from GET:
        // a recent Run page cannot establish whether an event was included in that count already.
        const reconciled = Array.from(request.projections.values()).reduce(
          applyProjection,
          snapshot,
        );
        setWorkspace(reconciled);
        succeeded = true;
      } catch (cause) {
        if (request.generation !== generation.current || request.controller.signal.aborted) return;
        onError(
          cause instanceof Error ? cause.message : "无法连接 OpenBot Server。请确认服务已启动。",
        );
      } finally {
        request.projections.clear();
        if (pending.current === request) {
          pending.current = undefined;
          // An event during this GET may be newer than its database snapshot. Read once more;
          // replay itself never invalidates. Failure waits for a later event or explicit retry.
          if (succeeded && reconcileNeeded.current) scheduleReconciliation(readWorkspace);
          else reconcileNeeded.current = false;
        }
      }
    },
    [onError, scheduleReconciliation],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      reconcileNeeded.current = false;
      if (reconcileTimer.current !== undefined) clearTimeout(reconcileTimer.current);
      reconcileTimer.current = undefined;
      generation.current += 1;
      pending.current?.controller.abort();
      pending.current?.projections.clear();
      pending.current = undefined;
    };
  }, [refresh]);

  const projectChannel = useCallback(
    (channel: Channel) => project({ type: "channel", channel }),
    [project],
  );
  const projectBot = useCallback((bot: Bot) => project({ type: "bot", bot }), [project]);
  const projectNodes = useCallback(
    (nodes: ExecutionNode[]) => project({ type: "nodes", nodes }),
    [project],
  );
  const projectNode = useCallback(
    (node: ExecutionNode) => project({ type: "node", node }),
    [project],
  );
  const removeNode = useCallback((id: string) => project({ type: "node-removed", id }), [project]);
  const projectRun = useCallback(
    (run: Run, artifacts: Artifact[] = []) => {
      if (!mounted.current) return;
      project({ type: "run", run });
      for (const artifact of artifacts) project({ type: "artifact", artifact });
      reconcileNeeded.current = true;
      scheduleReconciliation(refresh);
    },
    [project, refresh, scheduleReconciliation],
  );
  const projectProgress = useCallback(
    (progress: RunProgress) => project({ type: "progress", progress }),
    [project],
  );
  const projectApproval = useCallback(
    (approval: Approval, run: Run) => {
      project({ type: "approval", approval });
      projectRun(run);
    },
    [project, projectRun],
  );

  return {
    workspace,
    refresh,
    projectChannel,
    projectBot,
    projectNodes,
    projectNode,
    removeNode,
    projectRun,
    projectProgress,
    projectApproval,
  };
}

function recordProjection(journal: Map<string, Projection>, projection: Projection) {
  const key = projectionKey(projection);
  const previous = journal.get(key);
  // Runs can arrive through both channel and workspace streams. Preserve the
  // existing monotonic merge when coalescing repeated updates.
  if (
    previous?.type === "run" &&
    projection.type === "run" &&
    mergeRuns([previous.run], [projection.run])[0] === previous.run
  )
    return;
  if (
    previous?.type === "node" &&
    projection.type === "node" &&
    mergeNodes([previous.node], [projection.node])[0] === previous.node
  )
    return;
  journal.delete(key);
  journal.set(key, projection);
}

function projectionKey(projection: Projection): string {
  switch (projection.type) {
    case "channel":
      return `channel:${projection.channel.id}`;
    case "bot":
      return `bot:${projection.bot.id}`;
    case "nodes":
      return "nodes";
    case "node":
      return `node:${projection.node.id}`;
    case "node-removed":
      return `node:${projection.id}`;
    case "run":
      return `run:${projection.run.id}`;
    case "artifact":
      return `artifact:${projection.artifact.id}`;
    case "progress":
      return `progress:${projection.progress.id}`;
    case "approval":
      return `approval:${projection.approval.id}`;
  }
}

function applyProjection(current: WorkspaceSnapshot, projection: Projection): WorkspaceSnapshot {
  switch (projection.type) {
    case "channel": {
      const channels = upsert(current.channels, projection.channel);
      return { ...current, channels, counts: { ...current.counts, channels: channels.length } };
    }
    case "bot": {
      const bots = upsert(current.bots, projection.bot);
      return { ...current, bots, counts: { ...current.counts, bots: bots.length } };
    }
    case "nodes":
      return {
        ...current,
        nodes: projection.nodes,
        counts: { ...current.counts, connectedNodes: projection.nodes.length },
      };
    case "node": {
      const nodes = mergeNodes(current.nodes, [projection.node]);
      return { ...current, nodes, counts: { ...current.counts, connectedNodes: nodes.length } };
    }
    case "node-removed": {
      const nodes = current.nodes.filter((node) => node.id !== projection.id);
      return { ...current, nodes, counts: { ...current.counts, connectedNodes: nodes.length } };
    }
    case "run": {
      const runs = mergeRuns(current.runs, [projection.run]);
      const run = runs.find((item) => item.id === projection.run.id) ?? projection.run;
      // Replaying a coalesced run can skip its intermediate assignment. Its final
      // server projection owns occupancy, even if the snapshot has no prior run.
      const nodes = current.nodes.map((node) =>
        node.activeRunIds.includes(run.id)
          ? { ...node, activeRunIds: node.activeRunIds.filter((id) => id !== run.id) }
          : node,
      );
      return {
        ...current,
        runs,
        nodes: projectRunOnNodes(nodes, undefined, run),
      };
    }
    case "artifact":
      return { ...current, artifacts: mergeArtifacts(current.artifacts, [projection.artifact]) };
    case "progress":
      return { ...current, progress: mergeProgress(current.progress, [projection.progress]) };
    case "approval":
      return {
        ...current,
        approvals: upsert(current.approvals, projection.approval)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, 100),
      };
  }
}

function upsert<T extends { id: string }>(items: T[], value: T): T[] {
  return items.some((item) => item.id === value.id)
    ? items.map((item) => (item.id === value.id ? value : item))
    : [...items, value];
}
