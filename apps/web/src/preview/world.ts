/**
 * Synthetic workspace for the design preview (dev only). Names and contents follow the canvas
 * artboards so screenshots compare one to one. Nothing here is real data or a credential.
 */
const T = "2026-09-30T01:30:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

type Json = Record<string, unknown>;

export interface PreviewWorld {
  bots: Json[];
  channels: Json[];
  runs: Json[];
  approvals: Json[];
  artifacts: Json[];
  nodes: Json[];
  messages: Record<string, Json[]>;
  unread: Record<string, number>;
}

const bot = (
  id: string,
  name: string,
  role: string,
  head: string,
  accent: string,
  status = "idle",
): Json => ({
  id,
  name,
  role,
  status,
  computerProfile: "none",
  model: { connectionId: "conn-anthropic", modelId: "claude-sonnet" },
  appearance: { head, body: "classic", mobility: "feet", accessory: "none", accent },
  createdAt: T,
});

export function createWorld(kind: "full" | "empty" = "full"): PreviewWorld {
  if (kind === "empty")
    return {
      bots: [],
      channels: [],
      runs: [],
      approvals: [],
      artifacts: [],
      nodes: [],
      messages: {},
      unread: {},
    };
  const bots = [
    bot("b-research", "研究助理", "信息 · 竞品研究", "round", "green", "running"),
    bot("b-cs", "客服小橙", "客服 · 工单", "cat", "yellow"),
    bot("b-release", "发布助手", "开发 · 发布说明", "square", "blue"),
    bot("b-design", "设计评审", "设计 · 走查", "square", "red"),
    bot("b-ops", "运维值班", "运维 · 巡检", "round", "blue", "offline"),
  ];
  const activity = (preview: string, authorType: string, minutes: number) => ({
    lastActivityAt: minutesAgo(minutes),
    latestMessage: {
      id: `p-${minutes}`,
      authorType,
      preview,
      createdAt: minutesAgo(minutes),
    },
  });
  const channels = [
    {
      id: "c-market",
      name: "市场周报",
      description: "每周跟踪竞品动态，周五发团队周报",
      botIds: ["b-research", "b-cs"],
      createdAt: T,
      ...activity("周报初稿好了，等你看一下", "bot", 30),
    },
    {
      id: "c-release",
      name: "发布协作",
      description: "准备 2.4 版本发布",
      botIds: ["b-release", "b-design", "b-cs"],
      createdAt: T,
      ...activity("2.4 发布说明已更新", "bot", 90),
    },
    {
      id: "c-product",
      name: "产品讨论",
      description: "",
      botIds: [],
      createdAt: T,
      ...activity("下周一再过一遍需求", "human", 4000),
    },
    {
      id: "direct-b-research",
      name: "研究助理",
      description: "",
      directBotId: "b-research",
      botIds: ["b-research"],
      createdAt: T,
      ...activity("本周素材已整理完，稍后发你汇总。", "bot", 50),
    },
    {
      id: "direct-b-cs",
      name: "客服小橙",
      description: "",
      directBotId: "b-cs",
      botIds: ["b-cs"],
      createdAt: T,
      ...activity("今天的 12 个工单都回复了。", "bot", 1500),
    },
  ];
  const running = {
    id: "r-1",
    channelId: "c-market",
    botId: "b-research",
    title: "抓取竞品更新日志",
    instruction: "抓取竞品更新日志",
    sourceMessageId: "m-1",
    executionProfile: "none",
    status: "running",
    createdAt: minutesAgo(20),
    updatedAt: minutesAgo(1),
  };
  const done = {
    ...running,
    id: "r-done",
    title: "整理本周周报",
    status: "completed",
    updatedAt: minutesAgo(40),
  };
  return {
    bots,
    channels,
    runs: [running, done],
    approvals: [
      {
        id: "ap-1",
        runId: "r-1",
        channelId: "c-market",
        botId: "b-research",
        nodeId: "n-1",
        action: "email.send",
        target: "team@example.com",
        summary: "发送邮件给 team@example.com",
        risk: "write",
        targetFingerprint: "0".repeat(64),
        beforeState: {},
        status: "pending",
        expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
        createdAt: minutesAgo(2),
      },
    ],
    artifacts: [
      {
        id: "art-1",
        runId: "r-done",
        name: "weekly-2026-w40.md",
        mediaType: "text/markdown",
        sha256: "0".repeat(64),
        sizeBytes: 5120,
        createdAt: minutesAgo(45),
      },
    ],
    nodes: [
      {
        id: "n-1",
        name: "我的 MacBook Pro",
        platform: "macos",
        osVersion: "26",
        architecture: "arm64",
        deviceClass: "laptop",
        isolation: "host",
        trustTier: "owner",
        capabilities: [],
        capabilityManifest: [],
        activeRunIds: [],
        maxConcurrentRuns: 2,
        connectedAt: T,
        lastSeenAt: minutesAgo(1),
      },
    ],
    messages: {
      "c-market": [
        {
          id: "m-1",
          channelId: "c-market",
          authorType: "human",
          content: "帮我整理一下本周三家竞品的更新，做成一页周报发到这里。",
          createdAt: minutesAgo(25),
        },
        {
          id: "m-2",
          channelId: "c-market",
          authorType: "bot",
          authorId: "b-research",
          runId: "r-1",
          content:
            "收到。我会先读 `weekly/competitors.md` 里的名单，再去三家官网和更新日志抓本周的变化，整理好后把草稿发在这里给你看。",
          createdAt: minutesAgo(24),
        },
        {
          id: "m-3",
          channelId: "c-market",
          authorType: "human",
          content: "A 公司那段再展开一点，写清楚团队版和个人版的差别。",
          createdAt: minutesAgo(10),
        },
        {
          id: "m-4",
          channelId: "c-market",
          authorType: "bot",
          authorId: "b-cs",
          replyToMessageId: "m-1",
          content: "我补充一下客服侧：本周有 3 个工单提到 A 公司的团队版。",
          createdAt: minutesAgo(8),
        },
      ],
      "direct-b-research": [
        {
          id: "d-1",
          channelId: "direct-b-research",
          authorType: "human",
          content: "这周的素材整理好了吗？",
          createdAt: minutesAgo(55),
        },
        {
          id: "d-2",
          channelId: "direct-b-research",
          authorType: "bot",
          authorId: "b-research",
          content: "本周素材已整理完，稍后发你汇总。",
          createdAt: minutesAgo(50),
        },
      ],
    },
    unread: { "c-release": 2 },
  };
}

/** Bot 档案 projection for one Bot, shaped like `GET /api/v1/bots/:id/profile`. */
export function profileFor(world: PreviewWorld, botId: string): Json | undefined {
  const employee = world.bots.find((item) => item.id === botId);
  if (!employee) return undefined;
  const skill = (id: string, name: string, state: string) => ({
    id,
    slug: id,
    name,
    description: `${name}：示例技能说明。`,
    version: "1.0.0",
    source: "learned",
    state,
    confidence: 0.9,
    requiredCapabilities: [],
    dependencyIds: [],
    evidence: [],
    acquiredAt: T,
    updatedAt: T,
  });
  return {
    employee,
    details: {
      description: "跟踪竞品官网、更新日志和社交媒体，整理成周报发到频道。",
      revision: 1,
      updatedAt: T,
    },
    evolution: [
      {
        id: "ev-1",
        botId,
        type: "skill_verified",
        title: "新增技能「读取更新日志」",
        summary: "通过确定性测试",
        source: "run",
        evidence: [],
        createdAt: "2026-09-28T03:00:00.000Z",
      },
    ],
    skills: [skill("s1", "读取更新日志", "verified"), skill("s2", "网页截图对比", "verified")],
    memories: [],
    memoryEvents: [],
    records: { runs: world.runs, approvals: [], artifacts: [], decisions: [] },
    statistics: { totalRuns: 12, completedRuns: 10, failedRuns: 1, verifiedSkills: 2 },
    configuration: {
      executionProfile: "none",
      model: { connectionId: "conn-anthropic", modelId: "claude-sonnet" },
      portabilityFormat: "openbot.employee/v1",
    },
  };
}
