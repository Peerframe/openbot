// Fixed Bots, channel, prompt, report and messages for the website demo; synthetic data only.
import type { Artifact, Bot, Channel, Message, Run } from "@openbot/domain";

export const demoTime = "2026-09-10T01:30:00.000Z";
export const demoBots: Bot[] = [
  {
    id: "demo-editor",
    name: "Milo",
    role: "项目统筹 · 把任务整理成可交付的结果",
    status: "idle",
    computerProfile: "none",
    appearance: {
      head: "round",
      body: "classic",
      mobility: "feet",
      accessory: "headphones",
      accent: "green",
    },
    createdAt: demoTime,
  },
  {
    id: "demo-research",
    name: "Nova",
    role: "资料研究 · 整理材料、核对依据",
    status: "idle",
    computerProfile: "none",
    appearance: { head: "cat", body: "tall", mobility: "hover", accessory: "none", accent: "blue" },
    createdAt: demoTime,
  },
  {
    id: "demo-review",
    name: "Otto",
    role: "内容审阅 · 检查结构与交付细节",
    status: "idle",
    computerProfile: "none",
    appearance: {
      head: "square",
      body: "storage",
      mobility: "dual-wheel",
      accessory: "backpack",
      accent: "yellow",
    },
    createdAt: demoTime,
  },
];
export const demoChannel: Channel = {
  id: "demo-launch",
  name: "产品发布",
  description: "从一个想法，到一份可以交付的文件",
  botIds: demoBots.map((bot) => bot.id),
  createdAt: demoTime,
};
export const demoPrompt =
  "Milo，帮我整理一份 OpenBot 发布介绍。请 Nova 梳理功能，Otto 检查表达，最后交付 Markdown 文件。";
export const demoReport =
  "# OpenBot 发布介绍\n\n> 官网交互演示的固定示例文件，不连接模型。\n\n## 一个频道，完成协作\n\n把任务交给 Milo，由 Nova 整理功能、Otto 检查表达，最后由 Milo 汇总交付。\n\n## 可以看见的过程\n\n- Bot 使用自己的身份发言，保留委派和回复关系。\n- 在频道中查看分工、逐段回复与任务状态。\n- 回复消息、添加表情，下载产出文件。\n\n## 下一步\n\n在自己的 OpenBot 工作区配置模型，创建 Bot 并邀请它们加入频道。\n";
export const demoArtifact: Artifact = {
  id: "demo-launch-report",
  runId: "demo-root",
  name: "OpenBot-发布介绍.md",
  mediaType: "text/markdown",
  sha256: "0".repeat(64),
  sizeBytes: new TextEncoder().encode(demoReport).byteLength,
  createdAt: demoTime,
};
export function demoMessage(
  id: string,
  content: string,
  authorId?: string,
  runId?: string,
  offset = 0,
): Message {
  return {
    id,
    channelId: demoChannel.id,
    content,
    authorType: authorId ? "bot" : "human",
    ...(authorId ? { authorId } : {}),
    ...(runId ? { runId } : {}),
    createdAt: new Date(Date.parse(demoTime) + offset * 1000).toISOString(),
  };
}
export function demoRun(
  id: string,
  botId: string,
  title: string,
  sourceMessageId: string,
  parentRunId?: string,
): Run {
  return {
    id,
    channelId: demoChannel.id,
    botId,
    title,
    instruction: title,
    sourceMessageId,
    executionProfile: "none",
    status: "running",
    createdAt: demoTime,
    updatedAt: demoTime,
    ...(parentRunId
      ? { parentRunId, rootRunId: "demo-root", delegatedByBotId: "demo-editor" }
      : {}),
  };
}
