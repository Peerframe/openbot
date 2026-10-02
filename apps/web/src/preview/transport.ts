import { createWorld, knowledgeProposalsFor, type PreviewWorld, profileFor } from "./world";

/*
 * Design preview transport (dev only, never in a product build). It replaces `fetch`,
 * `EventSource` and browser storage before any product module loads, answers from the synthetic
 * world, and fails closed: foreign origins throw, unknown routes answer 404, and the real network
 * transport is never called. The page's CSP also sets `connect-src 'none'`.
 */

type Json = Record<string, unknown>;
type Handler = (match: RegExpMatchArray, body: Json) => Response | Promise<Response>;

const json = (value: unknown, status = 200) => Response.json(value, { status });

export function createPreviewFetch(origin: string, world: PreviewWorld = createWorld()) {
  const channel = (id: string) => world.channels.find((item) => item.id === id);
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
          progress: [],
          counts: {
            channels: world.channels.length,
            bots: world.bots.length,
            connectedNodes: world.nodes.length,
            activeRuns: world.runs.filter((run) => run.status === "running").length,
          },
        }),
    ],
    ["GET", /^\/api\/v1\/channels\/unread$/, () => json({ unread: world.unread })],
    [
      "GET",
      /^\/api\/v1\/channels\/([^/]+)\/messages$/,
      (m) => json({ messages: world.messages[m[1] ?? ""] ?? [] }),
    ],
    [
      "GET",
      /^\/api\/v1\/channels\/([^/]+)\/runs$/,
      (m) => json({ runs: world.runs.filter((run) => run.channelId === m[1]) }),
    ],
    ["GET", /^\/api\/v1\/channels\/([^/]+)\/reactions$/, () => json({ reactions: [] })],
    ["GET", /^\/api\/v1\/channels\/([^/]+)\/attachments$/, () => json({ attachments: [] })],
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
        return json({ message });
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
    ["GET", /^\/api\/v1\/plugins$/, () => json({ plugins: [], pendingCalls: [] })],
    [
      "GET",
      /^\/api\/v1\/plugins\/catalog$/,
      () => json({ format: "openbot.reviewed-plugin-catalog/v1", revision: 1, entries: [] }),
    ],
    [
      "GET",
      /^\/api\/v1\/model-services$/,
      () => json({ presets: [], connections: [], customBaseUrls: [] }),
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
      if (match) return handler(match, body);
    }
    console.warn(`[design preview] no synthetic route for ${method} ${url.pathname}`);
    return json({ error: "preview_unsupported" }, 404);
  };
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
