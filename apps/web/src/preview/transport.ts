import { modelProviderPresets } from "@openbot/domain";
import {
  attachmentsFor,
  createWorld,
  knowledgeProposalsFor,
  type PreviewWorld,
  profileFor,
} from "./world";

/*
 * Design preview transport (dev only, never in a product build). It replaces `fetch`,
 * `EventSource` and browser storage before any product module loads, answers from the synthetic
 * world, and fails closed: foreign origins throw, unknown routes answer 404, and the real network
 * transport is never called. The page's CSP also sets `connect-src 'none'`.
 */

type Json = Record<string, unknown>;
type Handler = (match: RegExpMatchArray, body: Json, url: URL) => Response | Promise<Response>;

const json = (value: unknown, status = 200) => Response.json(value, { status });

/**
 * The EmployeeBrowser artboard's state: the Owner holds control of a page drawn here, so the
 * preview shows a frame without any real browser, network or credentials.
 */
let browserFrame: string | undefined;
function browserView(botId: string) {
  browserFrame ??= drawPricingPage();
  return {
    id: "preview-browser",
    botId,
    nodeId: "n-1",
    nodeName: "我的 MacBook Pro",
    control: "mine",
    controlAvailable: true,
    controlExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    frame: {
      base64: browserFrame,
      width: 1280,
      height: 800,
      capturedAt: new Date().toISOString(),
      url: "https://b-company.com/pricing",
    },
  };
}
function drawPricingPage(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 800;
  const context = canvas.getContext("2d");
  if (!context)
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1280, 800);
  context.fillStyle = "#1d1d1f";
  context.font = "600 40px -apple-system, sans-serif";
  context.fillText("B Company · Pricing", 80, 120);
  const plans = ["Starter", "Team", "Enterprise"];
  plans.forEach((plan, index) => {
    const x = 80 + index * 380;
    context.fillStyle = "#f0f0f2";
    context.fillRect(x, 190, 340, 460);
    context.fillStyle = "#1d1d1f";
    context.font = "600 28px -apple-system, sans-serif";
    context.fillText(plan, x + 32, 250);
    context.font = "700 44px -apple-system, sans-serif";
    context.fillText(`$${(index + 1) * 12}`, x + 32, 320);
    context.fillStyle = "#c7c7cc";
    for (let line = 0; line < 5; line += 1) context.fillRect(x + 32, 370 + line * 44, 260, 14);
  });
  return canvas.toDataURL("image/png").split(",")[1] ?? "";
}

/** Synthetic plugins: one granted to 研究助理 (已连接), two not yet granted (需要授权). */
const plugin = (id: string, name: string, granted: boolean) => ({
  id,
  name,
  endpoint: `https://plugins.example.test/${id}`,
  tools: [{ name: "search", description: `${name} 搜索`, inputSchema: { type: "object" } }],
  digest: "0".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  enabled: true,
  createdAt: "2026-09-20T01:00:00.000Z",
  grants: granted ? [{ botId: "b-research", tools: [{ name: "search", mode: "read" }] }] : [],
});
const previewPlugins = [
  plugin("github", "GitHub", true),
  plugin("gmail", "Gmail", false),
  plugin("drive", "Google Drive", false),
];

/** DialogModel artboard: the model list a verified Anthropic key returns (synthetic). */
const previewModels = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5",
  "claude-opus-4-1",
  "claude-3-7-sonnet",
];

export function createPreviewFetch(origin: string, world: PreviewWorld = createWorld()) {
  const channel = (id: string) => world.channels.find((item) => item.id === id);
  // C21 fixtures: purged files leave the listing; the 30-day purge starts off.
  const purged = new Set<string>();
  const liveAttachments = (channelId: string) =>
    attachmentsFor(channelId).filter((item) => !purged.has(String(item.id)));
  const storageSettings = {
    revision: 1,
    trashAutoPurgeDays: null as 30 | null,
    updatedAt: null as string | null,
    lastAutoPurgeAt: null as string | null,
  };
  const connections: Json[] = [
    {
      id: "conn-anthropic",
      name: "Anthropic",
      presetId: "anthropic",
      baseUrl: "https://api.anthropic.com",
      protocol: "anthropic-messages",
      enabled: true,
      hasApiKey: true,
      revision: 3,
      source: "saved",
      defaultModel: "claude-sonnet-5",
      createdAt: "2026-09-20T01:00:00.000Z",
      updatedAt: "2026-09-30T01:30:00.000Z",
    },
  ];
  const routes: Array<[string, RegExp, Handler]> = [
    [
      "GET",
      /^\/api\/v1\/auth\/session$/,
      () =>
        json({
          authenticated: true,
          expiresAt: "2999-01-01T00:00:00.000Z",
          owner: { id: "owner", name: "雨贺" },
        }),
    ],
    [
      "GET",
      /^\/api\/v1\/workspace$/,
      () =>
        json({
          channels: world.channels,
          bots: world.bots,
          nodes: world.nodes,
          runs: world.runs,
          approvals: world.approvals,
          artifacts: world.artifacts,
          progress: world.runs.some((run) => run.id === "r-1")
            ? [
                {
                  id: "p-r-1",
                  runId: "r-1",
                  channelId: "c-market",
                  stage: "browse",
                  message: "打开网页 b-company.com/changelog",
                  createdAt: new Date().toISOString(),
                },
              ]
            : [],
          runProgress: Object.fromEntries(
            world.runs.map((run) => {
              const { steps: _steps, ...summary } = runProgress(run);
              return [run.id, summary];
            }),
          ),
          counts: {
            channels: world.channels.length,
            bots: world.bots.length,
            connectedNodes: world.nodes.length,
            activeRuns: world.runs.filter((run) => run.status === "running").length,
          },
        }),
    ],
    [
      "GET",
      /^\/api\/v1\/runs\/([^/]+)\/progress$/,
      (m) => {
        const run = world.runs.find((item) => item.id === m[1]);
        return run ? json(runProgress(run)) : json({ error: "not_found" }, 404);
      },
    ],
    ["GET", /^\/api\/v1\/channels\/unread$/, () => json({ unread: world.unread })],
    [
      "GET",
      /^\/api\/v1\/channels\/([^/]+)\/messages$/,
      (m, _body, url) => {
        // C18 pages of 100, oldest first; the preview cursor is simply the oldest message's id.
        const all = world.messages[m[1] ?? ""] ?? [];
        const before = url.searchParams.get("before");
        const end = before ? all.findIndex((item) => item.id === before) : all.length;
        const page = all.slice(Math.max(0, end - 100), Math.max(0, end));
        const hasMore = end - page.length > 0;
        return json({
          messages: page,
          hasMore,
          ...(hasMore && page[0] ? { nextCursor: page[0].id } : {}),
        });
      },
    ],
    [
      "GET",
      /^\/api\/v1\/channels\/([^/]+)\/runs$/,
      (m) => json({ runs: world.runs.filter((run) => run.channelId === m[1]) }),
    ],
    ["GET", /^\/api\/v1\/channels\/([^/]+)\/reactions$/, () => json({ reactions: [] })],
    [
      "GET",
      /^\/api\/v1\/channels\/([^/]+)\/attachments$/,
      (m) => json({ attachments: liveAttachments(m[1] ?? "") }),
    ],
    [
      "DELETE",
      /^\/api\/v1\/channels\/([^/]+)\/attachments\/([^/]+)\/purge$/,
      (m) => {
        const file = liveAttachments(m[1] ?? "").find((item) => item.id === m[2]);
        if (!file) return json({ error: "not_found" }, 404);
        const count = file.referenceCount as { messages: number; tasks: number };
        if (count.messages + count.tasks > 0)
          return json({ error: "attachment_referenced", referenceCount: count }, 409);
        purged.add(String(file.id));
        return json({ id: file.id, purged: true, freedBytes: file.sizeBytes });
      },
    ],
    [
      "POST",
      /^\/api\/v1\/channels\/([^/]+)\/attachments\/cleanup$/,
      (m) => {
        const trash = liveAttachments(m[1] ?? "").filter((item) => item.deletedAt);
        const kept = trash.filter((item) => {
          const count = item.referenceCount as { messages: number; tasks: number };
          return count.messages + count.tasks > 0;
        });
        const removed = trash.filter((item) => !kept.includes(item));
        for (const item of removed) purged.add(String(item.id));
        return json({
          removed: removed.length,
          retained: kept.map(({ id, name, referenceCount }) => ({ id, name, referenceCount })),
          retainedCount: kept.length,
          retainedHasMore: false,
          freedBytes: removed.reduce((sum, item) => sum + Number(item.sizeBytes), 0),
        });
      },
    ],
    [
      "GET",
      /^\/api\/v1\/storage$/,
      () => {
        const GB = 1_000_000_000;
        return json({
          totalBytes: 19.6 * GB,
          measuredAt: new Date().toISOString(),
          categories: {
            channelFiles: { sizeBytes: 9.2 * GB, fileCount: 312 },
            taskOutputs: { sizeBytes: 5.8 * GB, fileCount: 140 },
            retainedRunOutputs: null,
            ownerTaskFiles: { sizeBytes: 0.9 * GB, fileCount: 18 },
            database: { sizeBytes: 2.1 * GB },
            other: { sizeBytes: 0.4 * GB, fileCount: 6 },
            trash: { sizeBytes: 1.2 * GB, fileCount: 12 },
            workingComputerBrowserData: null,
          },
          trash: {
            fileCount: 12,
            sizeBytes: 1.2 * GB,
            referencedFileCount: 3,
            referencedSizeBytes: 0.3 * GB,
          },
          topChannels: [
            {
              id: "c-market",
              name: "市场周报",
              deleted: false,
              sizeBytes: 6.1 * GB,
              fileCount: 214,
            },
            {
              id: "c-launch",
              name: "发布协作",
              deleted: false,
              sizeBytes: 2.0 * GB,
              fileCount: 88,
            },
            {
              id: "direct-b-research",
              name: "研究助理",
              deleted: false,
              sizeBytes: 1.1 * GB,
              fileCount: 37,
            },
          ],
          topChannelsLimit: 20,
        });
      },
    ],
    [
      "POST",
      /^\/api\/v1\/storage\/trash\/cleanup$/,
      () =>
        json({
          removed: 9,
          retained: [],
          retainedCount: 3,
          retainedHasMore: false,
          freedBytes: 900_000_000,
          channelCount: 4,
        }),
    ],
    [
      "GET",
      /^\/api\/v1\/channels\/([^/]+)\/attachments\/([^/]+)\/references$/,
      () =>
        json({
          messages: [
            {
              id: "m-ref-1",
              createdAt: "2026-09-18T02:10:00.000Z",
              author: { kind: "owner" },
              preview: "这是上个月的渠道数据。",
            },
            {
              id: "m-ref-2",
              createdAt: "2026-09-17T08:30:00.000Z",
              author: { kind: "bot", botId: "b-research" },
              preview: "我按渠道把 8 月的数据整理成了表格。",
            },
            {
              id: "m-ref-3",
              createdAt: "2026-09-16T01:00:00.000Z",
              author: { kind: "system" },
              preview: "例行任务「每周渠道汇总」已开始。",
            },
          ],
          tasks: [],
          messageCount: 3,
          taskCount: 0,
          hasMore: false,
        }),
    ],
    [
      "POST",
      /^\/api\/v1\/bots\/([^/]+)\/browser\/maintenance$/,
      (m) =>
        json({
          // The protocol requires a UUID; the preview's readable Bot ids are mapped to one.
          botId: "00000000-0000-4000-8000-00000000b0b0",
          nodeId: "n-1",
          running: true,
          paused: false,
          // The deployed upstream cannot measure yet for one Bot: shown as 「量不出」.
          profileBytes: m[1] === "b-research" ? 186_000_000 : null,
        }),
    ],
    ["GET", /^\/api\/v1\/settings\/storage$/, () => json(storageSettings)],
    [
      "PUT",
      /^\/api\/v1\/settings\/storage$/,
      (_m, body) => {
        Object.assign(storageSettings, {
          revision: storageSettings.revision + 1,
          trashAutoPurgeDays: body.trashAutoPurgeDays === 30 ? 30 : null,
          updatedAt: new Date().toISOString(),
        });
        return json(storageSettings);
      },
    ],
    ["POST", /^\/api\/v1\/bots\/([^/]+)\/browser$/, (m) => json(browserView(m[1] ?? ""))],
    [
      "POST",
      /^\/api\/v1\/browser-sessions\/([^/]+)\/commands$/,
      () => json(browserView("b-research")),
    ],
    ["DELETE", /^\/api\/v1\/browser-sessions\/([^/]+)$/, () => new Response(null, { status: 204 })],
    [
      "POST",
      /^\/api\/v1\/channels\/([^/]+)\/read$/,
      (m) => {
        delete world.unread[m[1] ?? ""];
        return json({ channelId: m[1], lastReadAt: new Date().toISOString() });
      },
    ],
    [
      "POST",
      /^\/api\/v1\/channels\/([^/]+)\/messages$/,
      (m, body) => {
        const message = {
          id: `m-${Date.now()}`,
          channelId: m[1],
          authorType: "human",
          content: String(body.content ?? ""),
          createdAt: new Date().toISOString(),
        };
        const list = world.messages[m[1] ?? ""] ?? [];
        list.push(message);
        world.messages[m[1] ?? ""] = list;
        const target = channel(m[1] ?? "");
        const botId = String(
          body.botId ??
            target?.directBotId ??
            ((target?.botIds as string[]) ?? [])[0] ??
            "b-research",
        );
        const run = {
          id: `r-${Date.now()}`,
          channelId: m[1],
          botId,
          title: message.content.slice(0, 40),
          instruction: message.content,
          sourceMessageId: message.id,
          executionProfile: "none",
          status: "completed",
          createdAt: message.createdAt,
          updatedAt: message.createdAt,
        };
        // A short synthetic reply, so the Telegram-like arrival can be seen in the preview.
        setTimeout(() => {
          const reply = {
            id: `m-reply-${Date.now()}`,
            channelId: m[1],
            authorType: "bot",
            authorId: botId,
            runId: run.id,
            content: "好的，已经记下了。",
            createdAt: new Date().toISOString(),
          };
          list.push(reply);
          emitChannelEvent(m[1] ?? "", {
            type: "message.created",
            channelId: m[1],
            message: reply,
          });
        }, 1200);
        return json({ message, run });
      },
    ],
    [
      "POST",
      /^\/api\/v1\/channels\/([^/]+)\/bots$/,
      (m, body) => {
        const target = channel(m[1] ?? "");
        if (!target) return json({ error: "not_found" }, 404);
        target.botIds = [...((target.botIds as string[]) ?? []), String(body.botId)];
        return json({ channel: target });
      },
    ],
    [
      "DELETE",
      /^\/api\/v1\/channels\/([^/]+)\/bots\/([^/]+)$/,
      (m) => {
        const target = channel(m[1] ?? "");
        if (!target) return json({ error: "not_found" }, 404);
        target.botIds = ((target.botIds as string[]) ?? []).filter((id) => id !== m[2]);
        return json({ channel: target, cancelledRuns: [] });
      },
    ],
    [
      "POST",
      /^\/api\/v1\/channels$/,
      (_m, body) => {
        const created = {
          id: `c-${Date.now()}`,
          name: String(body.name ?? "新频道"),
          description: String(body.description ?? ""),
          botIds: Array.isArray(body.botIds) ? body.botIds : [],
          createdAt: new Date().toISOString(),
        };
        world.channels.push(created);
        return json({ channel: created }, 201);
      },
    ],
    [
      "POST",
      /^\/api\/v1\/bots\/quick$/,
      (_m, body) => {
        const taken = new Set(world.bots.map((item) => item.name));
        let index = 1;
        while (taken.has(index === 1 ? "新建 Bot" : `新建 Bot ${index}`)) index += 1;
        const name = index === 1 ? "新建 Bot" : `新建 Bot ${index}`;
        const id = `b-new-${Date.now()}`;
        const created = {
          id,
          name,
          role: "通用助手",
          status: "idle",
          computerProfile: "none",
          appearance: body.appearance,
          createdAt: new Date().toISOString(),
        };
        const direct = {
          id: `direct-${id}`,
          name,
          description: "",
          directBotId: id,
          botIds: [id],
          createdAt: created.createdAt,
        };
        world.bots.push(created);
        world.channels.push(direct);
        return json({ bot: created, channel: direct }, 201);
      },
    ],
    [
      "POST",
      /^\/api\/v1\/bots\/([^/]+)\/conversation$/,
      (m) => {
        const existing = world.channels.find((item) => item.directBotId === m[1]);
        if (existing) return json({ channel: existing });
        const owner = world.bots.find((item) => item.id === m[1]);
        const created = {
          id: `direct-${m[1]}`,
          name: owner?.name ?? "Bot",
          description: "",
          directBotId: m[1],
          botIds: [m[1]],
          createdAt: new Date().toISOString(),
        };
        world.channels.push(created);
        return json({ channel: created });
      },
    ],
    [
      "GET",
      /^\/api\/v1\/bots\/([^/]+)\/profile$/,
      (m) => {
        const profile = profileFor(world, m[1] ?? "");
        return profile ? json({ profile }) : json({ error: "not_found" }, 404);
      },
    ],
    [
      "GET",
      /^\/api\/v1\/bots\/([^/]+)\/knowledge-proposals$/,
      (m) => json({ proposals: knowledgeProposalsFor(m[1] ?? "") }),
    ],
    ["GET", /^\/api\/v1\/runs\/([^/]+)\/output$/, () => json({ output: null })],
    ["GET", /^\/api\/v1\/plugins$/, () => json({ plugins: previewPlugins, pendingCalls: [] })],
    [
      "GET",
      /^\/api\/v1\/plugins\/catalog$/,
      () => json({ format: "openbot.reviewed-plugin-catalog/v1", revision: 1, entries: [] }),
    ],
    [
      "GET",
      /^\/api\/v1\/model-services$/,
      () => json({ presets: modelProviderPresets, connections, customBaseUrls: [] }),
    ],
    ["POST", /^\/api\/v1\/model-connections\/verify$/, () => json({ models: previewModels })],
    [
      "POST",
      /^\/api\/v1\/model-connections\/([^/]+)\/models$/,
      () => json({ models: previewModels }),
    ],
    [
      "POST",
      /^\/api\/v1\/model-connections$/,
      (_m, body) => {
        const now = new Date().toISOString();
        const created = {
          id: `conn-${Date.now()}`,
          name: body.name,
          presetId: body.presetId,
          baseUrl: body.baseUrl,
          protocol: "openai-chat",
          enabled: true,
          hasApiKey: true,
          revision: 1,
          source: "saved",
          ...(typeof body.defaultModel === "string" ? { defaultModel: body.defaultModel } : {}),
          createdAt: now,
          updatedAt: now,
        };
        connections.push(created);
        return json({ connection: created }, 201);
      },
    ],
    [
      "PATCH",
      /^\/api\/v1\/model-connections\/([^/]+)$/,
      (m, body) => {
        const target = connections.find((item) => item.id === m[1]);
        if (!target) return json({ error: "model_connection_not_found" }, 404);
        const { expectedRevision: _revision, apiKey: _key, defaultModel, ...rest } = body;
        Object.assign(target, rest, { revision: Number(target.revision) + 1 });
        if (defaultModel === null) delete target.defaultModel;
        else if (typeof defaultModel === "string") target.defaultModel = defaultModel;
        return json({ connection: target });
      },
    ],
    [
      "DELETE",
      /^\/api\/v1\/model-connections\/([^/]+)$/,
      (m) => {
        // The artboard's refusal: a Bot and the owner default still use the only connection.
        if (m[1] === "conn-anthropic")
          return json(
            {
              error: "model_connection_in_use",
              bots: [{ id: "b-research", name: "研究助理" }],
              runIds: ["r-1"],
              ownerDefault: true,
            },
            409,
          );
        const index = connections.findIndex((item) => item.id === m[1]);
        if (index < 0) return json({ error: "model_connection_not_found" }, 404);
        connections.splice(index, 1);
        return json({ deleted: true, connectionId: m[1] });
      },
    ],
    [
      "GET",
      /^\/api\/v1\/settings\/model$/,
      () =>
        json({
          status: "configured",
          provider: "anthropic",
          model: "claude-sonnet",
          revision: "r1",
          agentEnabled: true,
        }),
    ],
    [
      "GET",
      /^\/api\/v1\/settings\/general$/,
      () =>
        json({
          revision: 1,
          timezone: "Asia/Shanghai",
          defaultModel: { connectionId: "conn-anthropic", modelId: "claude-sonnet" },
          updatedAt: "2026-09-30T01:30:00.000Z",
        }),
    ],
    ["GET", /^\/api\/v1\/automations$/, () => json({ automations: [] })],
    [
      "GET",
      /^\/api\/v1\/node-identities$/,
      () =>
        json({
          identities: world.nodes.map((node) => ({
            nodeId: node.id,
            status: "active",
            connected: true,
            enrolledAt: "2026-09-20T01:00:00.000Z",
          })),
        }),
    ],
    [
      "GET",
      /^\/api\/v1\/bots\/([^/]+)\/export\/preview$/,
      (m) => {
        const bot = world.bots.find((item) => item.id === m[1]);
        if (!bot) return json({ error: "not_found" }, 404);
        return json({
          preview: {
            format: "openbot.employee/v2",
            kind: "template",
            packageId: "00000000-0000-4000-8000-000000000001",
            fileName: `${bot.name}.openbot.json`,
            generatedAt: "2026-09-30T01:30:00.000Z",
            employee: { name: bot.name, role: bot.role, appearance: bot.appearance },
            skills: [
              ["changelog", "抓取更新日志"],
              ["screenshot-diff", "网页截图对比"],
              ["weekly", "周报模板"],
            ].map(([slug, name]) => ({
              slug,
              name,
              description: `${name}：示例技能说明。`,
              version: "1.0.0",
              requiredCapabilities: [],
              dependencySlugs: [],
            })),
            employeeName: bot.name,
            verifiedSkillCount: 3,
            requestedCapabilities: [],
            includedMemoryCount: 0,
            exclusions: [
              { category: "identity", count: 1, reason: "" },
              { category: "authority", count: 1, reason: "" },
              { category: "memory", count: 4, reason: "" },
              { category: "work-history", count: 12, reason: "" },
            ],
            findings: [],
            blocked: false,
            checksum: "9e66cc207913b178" + "0".repeat(44) + "9e53a3",
            downloadReviewToken: "0".repeat(64),
            signatureStatus: "unsigned",
            identityOnImport: "new",
            hostAuthority: "none",
          },
        });
      },
    ],
    ["GET", /^\/api\/v1\/audit$/, () => json({ events: [] })],
  ];

  return async function previewFetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), origin);
    if (url.origin !== origin) throw new TypeError("设计预览不连接外部服务。");
    init?.signal?.throwIfAborted();
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : request ? await request.text() : "";
    let body: Json = {};
    if (raw) {
      try {
        body = JSON.parse(raw) as Json;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
    }
    for (const [verb, pattern, handler] of routes) {
      if (verb !== method) continue;
      const match = url.pathname.match(pattern);
      if (match) return handler(match, body, url);
    }
    console.warn(`[design preview] no synthetic route for ${method} ${url.pathname}`);
    return json({ error: "preview_unsupported" }, 404);
  };
}

/** Open synthetic event streams, so preview routes can push channel events. */
const previewSources = new Set<EventTarget & { url: string }>();
function emitChannelEvent(channelId: string, event: { type: string } & Record<string, unknown>) {
  for (const source of previewSources)
    if (source.url.includes(`/channels/${channelId}/events`))
      source.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) }));
}

/** Install the preview transport. Call before importing any product module. */
export function installPreviewTransport(world: PreviewWorld) {
  window.fetch = createPreviewFetch(location.origin, world);
  class PreviewEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 0;
    readonly withCredentials = false;
    onopen: EventSource["onopen"] = null;
    onerror: EventSource["onerror"] = null;
    onmessage: EventSource["onmessage"] = null;
    constructor(readonly url: string) {
      super();
      previewSources.add(this);
      // A live stream that stays quiet: the header shows 实时 and nothing changes on its own.
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        const event = new Event("open");
        this.onopen?.call(this as unknown as EventSource, event);
        this.dispatchEvent(event);
      }, 0);
    }
    close() {
      this.readyState = 2;
      previewSources.delete(this);
    }
  }
  window.EventSource = PreviewEventSource as unknown as typeof EventSource;
  const memory = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return memory.size;
    },
    clear: () => memory.clear(),
    key: (index) => [...memory.keys()][index] ?? null,
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, String(value));
    },
    removeItem: (key) => {
      memory.delete(key);
    },
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: storage, configurable: true });
  return storage;
}

/** C13 details for the synthetic runs: three verified steps, the fourth one in progress. */
function runProgress(run: Record<string, unknown>) {
  const finished = run.status === "completed";
  // Stage keys from the 服务电脑's control-authored dictionary; the UI names them in Chinese.
  const names = ["context", "planning", "navigate", "navigate"];
  const count = finished ? 3 : 4;
  return {
    runId: run.id,
    status: run.status,
    totalSteps: count,
    currentStepNumber: count,
    plannedTotalSteps: null,
    completedSteps: 3,
    stageName: finished ? null : "navigate",
    description: finished ? null : "Open a page.",
    startedAt: run.createdAt,
    endedAt: null,
    failureReasonCode: null,
    steps: names.slice(0, count).map((name, index) => ({
      id: `${run.id}-step-${index + 1}`,
      stepNumber: index + 1,
      stageName: name,
      description: "Control-authored English description.",
      startedAt: run.createdAt,
      endedAt: index < 3 ? run.createdAt : null,
    })),
  };
}
