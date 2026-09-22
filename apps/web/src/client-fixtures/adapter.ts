import type {
  Approval,
  ChannelRealtimeEvent,
  Run,
  RunProgress,
  WorkspaceSnapshot,
} from "@openbot/domain";
import { DemoAdapter, type DemoSnapshot } from "../demo/adapter";
import {
  demoArtifact,
  demoBots,
  demoChannel,
  demoMessage,
  demoRun,
  demoTime,
} from "../demo/fixtures";

export const clientScenarios = [
  {
    id: "approval",
    label: "等待审批",
    instruction: "在右侧正式审批卡中批准或拒绝；只修改当前页合成数据。",
  },
  {
    id: "tool-fault",
    label: "工具故障",
    instruction: "触发工具故障，再打开正式任务详情查看失败原因。",
  },
  {
    id: "cancellation",
    label: "取消与迟到输出",
    instruction: "点击正式「停止任务」，再注入迟到输出；任务应保持已停止。",
  },
  {
    id: "partial-output",
    label: "部分输出",
    instruction: "逐段推进回复，重复和较旧事件不应让内容倒退。",
  },
  {
    id: "artifacts",
    label: "产物交付",
    instruction: "下载正式消息卡片中的固定 Markdown 文件；不访问真实工作区。",
  },
  {
    id: "reconnect",
    label: "断线重连",
    instruction: "断开 → 离线期间完成 → 恢复；正式客户端应自动补读遗漏的消息。",
  },
] as const;
export type ClientScenario = (typeof clientScenarios)[number]["id"];
export const fixtureRunId = "fixture-run";
const requestId = "fixture-request";
const initialText = "已核对第一项合成材料。";
const nextText = `${initialText}\n\n正在整理后续结果；这段内容尚未完成。`;
const finalText = "合成检查已完成，最终结果已保存。";

export interface ClientFixtureSnapshot extends DemoSnapshot {
  scenario: ClientScenario;
  online: boolean;
  step: number;
  approvals: Approval[];
  progress: RunProgress[];
}

/** No Server authority: this subclass is imported exclusively by the isolated fixture entry. */
export class ClientFixtureAdapter extends DemoAdapter {
  constructor(origin: string, scenario: ClientScenario = "approval") {
    super(origin);
    this.load(scenario);
  }
  override getSnapshot = () => this.snapshot as ClientFixtureSnapshot;
  private patch(update: Partial<ClientFixtureSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    this.publish();
  }
  load = (scenario: ClientScenario) => {
    const selected = clientScenarios.find((item) => item.id === scenario);
    if (!selected) throw new TypeError("Unknown client fixture scenario");
    this.restart();
    const run = demoRun(
      fixtureRunId,
      demoBots[0]?.id ?? "demo-editor",
      `客户端夹具：${selected.label}`,
      requestId,
    );
    if (scenario === "approval") run.status = "waiting_approval";
    const progress: RunProgress = {
      id: "fixture-progress",
      runId: run.id,
      channelId: demoChannel.id,
      stage: "planning",
      message: "已加载公开合成材料；未调用模型或外部工具。",
      createdAt: demoTime,
    };
    this.patch({
      scenario,
      online: true,
      step: 0,
      messages: [
        demoMessage(requestId, `请验证「${selected.label}」场景。${selected.instruction}`),
      ],
      runs: [run],
      artifacts: [],
      progress: [progress],
      approvals:
        scenario === "approval"
          ? [
              {
                id: "fixture-approval",
                runId: run.id,
                channelId: run.channelId,
                botId: run.botId,
                nodeId: "fixture-node",
                action: "form.submit",
                target: "fixture://synthetic-review",
                summary: "确认提交合成检查表（不会访问外部服务）",
                risk: "write",
                targetFingerprint: "fixture-only",
                beforeState: { synthetic: true },
                status: "pending",
                expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
                createdAt: demoTime,
              },
            ]
          : [],
    });
    if (["cancellation", "partial-output", "reconnect"].includes(scenario))
      this.output(run.id, initialText);
    if (scenario === "artifacts") this.complete(true);
  };
  private replaceRun(run: Run, artifact = false) {
    if (["completed", "failed", "cancelled"].includes(run.status)) this.outputs.delete(run.id);
    const artifacts = artifact ? [{ ...demoArtifact, runId: run.id }] : [];
    this.patch({
      runs: this.snapshot.runs.map((item) => (item.id === run.id ? run : item)),
      artifacts,
    });
    this.event({ type: "run.updated", channelId: demoChannel.id, run, artifacts });
  }
  private complete(artifact = false) {
    const current = this.snapshot.runs[0];
    if (!current || !["running", "waiting_approval"].includes(current.status)) return;
    const message = demoMessage("fixture-final", finalText, current.botId, current.id, 3);
    this.patch({ messages: [...this.snapshot.messages, message] });
    this.event({ type: "message.created", channelId: demoChannel.id, message });
    this.replaceRun(
      {
        ...current,
        status: "completed",
        resultSummary: finalText,
        updatedAt: new Date(Date.parse(demoTime) + 3000).toISOString(),
      },
      artifact,
    );
  }
  triggerFault = () => {
    const run = this.snapshot.runs[0];
    if (run?.status !== "running") return;
    const progress = {
      id: "fixture-tool-fault",
      runId: run.id,
      channelId: run.channelId,
      stage: "observation",
      message: "合成工具返回超时；未重试外部操作。",
      createdAt: new Date(Date.parse(demoTime) + 1000).toISOString(),
    };
    this.patch({ progress: [...this.getSnapshot().progress, progress] });
    this.event({ type: "run.progress", channelId: run.channelId, progress });
    this.replaceRun({
      ...run,
      status: "failed",
      errorCode: "tool_unavailable",
      errorMessage: "Synthetic tool timeout",
      updatedAt: progress.createdAt,
    });
  };
  advanceOutput = () => {
    if (this.getSnapshot().step === 0) {
      this.output(fixtureRunId, nextText);
      const current = this.outputs.get(fixtureRunId);
      if (current) {
        this.event({ type: "run.output", ...current });
        this.event({
          type: "run.output",
          ...current,
          sequence: current.sequence - 1,
          text: initialText,
        });
      }
      this.patch({ step: 1 });
    } else this.complete();
  };
  emitLateOutput = () => {
    this.event({
      type: "run.output",
      runId: fixtureRunId,
      channelId: demoChannel.id,
      botId: "demo-editor",
      sequence: 999,
      reset: false,
      text: "不应显示的迟到输出",
    });
  };
  disconnect = () => {
    this.patch({ online: false });
    for (const source of [...this.sources]) source.dispatchEvent(new Event("error"));
  };
  completeOffline = () => {
    if (!this.getSnapshot().online) this.complete();
  };
  reconnect = () => this.patch({ online: true });
  protected override event(event: ChannelRealtimeEvent) {
    if (this.getSnapshot().online) super.event(event);
  }
  override connect(source: EventTarget, url: string) {
    const disconnect = super.connect(source, url);
    if (this.getSnapshot().online) return disconnect;
    disconnect();
    let active = true;
    queueMicrotask(() => {
      if (active) source.dispatchEvent(new Event("error"));
    });
    return () => {
      active = false;
    };
  }
  protected override handleFixtureRequest(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ) {
    if (!this.getSnapshot().online)
      return Response.json({ error: "Synthetic fixture connection is offline" }, { status: 503 });
    if (method === "POST" && path === "/api/v1/approvals/fixture-approval/decision") {
      const approval = this.getSnapshot().approvals[0];
      const run = this.snapshot.runs[0];
      if (!approval || !run || approval.status !== "pending")
        return Response.json({ error: "Synthetic approval already resolved" }, { status: 409 });
      if (body.decision !== "approve" && body.decision !== "reject")
        return Response.json({ error: "Invalid fixture decision" }, { status: 400 });
      const resolved = {
        ...approval,
        status: body.decision === "approve" ? ("approved" as const) : ("rejected" as const),
        decidedBy: "fixture-owner",
        decidedAt: demoTime,
      };
      this.patch({ approvals: [resolved] });
      if (body.decision === "approve") this.complete();
      else
        this.replaceRun({
          ...run,
          status: "cancelled",
          updatedAt: new Date(Date.parse(demoTime) + 1000).toISOString(),
        });
      return Response.json({ approval: resolved, run: this.snapshot.runs[0] });
    }
    // Composer submissions and unrelated capabilities are intentionally not simulated in C2.
    if (method !== "GET" && path !== `/api/v1/runs/${fixtureRunId}/cancel`)
      return Response.json(
        { error: "此夹具只支持场景中的审批与取消；不会发送新任务。" },
        { status: 403 },
      );
    return undefined;
  }
  workspace(): WorkspaceSnapshot {
    const state = this.getSnapshot();
    return {
      channels: [demoChannel],
      bots: demoBots,
      nodes: [],
      runs: state.runs,
      artifacts: state.artifacts,
      approvals: state.approvals,
      progress: state.progress,
      counts: {
        channels: 1,
        bots: demoBots.length,
        connectedNodes: 0,
        activeRuns: state.runs.filter((run) =>
          ["queued", "running", "waiting_approval"].includes(run.status),
        ).length,
      },
    };
  }
}
