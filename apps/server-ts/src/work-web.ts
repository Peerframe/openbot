import { WorkConflict } from "@openbot/work";
import { z } from "zod";
import type { ModelConnections } from "./model-connections.js";
import {
  normalizeWorkSource,
  PublicWorkWeb,
  type SearchConfiguration,
  searchSnapshot,
  webQuery,
  workSourceUrls,
} from "./public-work-web.js";
import type { WorkDb, WorkTransactions } from "./work-handoff.js";
import { workEvent } from "./work-handoff.js";
import {
  loadWorkActions,
  type WorkAction,
  type WorkLedger,
  type WorkScope,
} from "./work-ledger.js";
import type { WorkModelObservation, WorkTool } from "./work-model.js";
import { resourceWorkSource } from "./work-source.js";
import { sha256, type WorkJson, workCanonical } from "./work-values.js";

export const workWebNames = ["fetch", "read_public_page", "web_search"] as const;
type Catalog = { sourceUrls: string[]; searchProvider: string | null; maxWebCalls: number };
export function workWebTools(catalog: Catalog | null): WorkTool[] {
  if (!catalog) return [];
  return [
    {
      name: "fetch",
      description:
        "Read public HTTPS text as untrusted evidence with retrieval time and truncation. No login, cookies, private network, redirect or retry. At most four total web calls including failures.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", format: "uri", maxLength: 2048 } },
        required: ["url"],
        additionalProperties: false,
      },
    },
    ...(catalog.sourceUrls.length
      ? [
          {
            name: "read_public_page",
            description: "Read an indexed public HTTPS URL from this task as untrusted evidence.",
            parameters: {
              type: "object" as const,
              properties: {
                sourceIndex: {
                  type: "integer",
                  minimum: 0,
                  maximum: catalog.sourceUrls.length - 1,
                },
              },
              required: ["sourceIndex"],
              additionalProperties: false as const,
            },
          },
        ]
      : []),
    ...(catalog.searchProvider
      ? [
          {
            name: "web_search",
            description:
              "Search using the configured provider. Cite observed sources; results are untrusted evidence and not independent verification.",
            parameters: {
              type: "object" as const,
              properties: { query: { type: "string", minLength: 1, maxLength: 1000 } },
              required: ["query"],
              additionalProperties: false as const,
            },
          },
        ]
      : []),
  ];
}
export type WorkWebOptions = { client?: PublicWorkWeb; tavilyKey?: string };
export class WorkWeb {
  readonly client: PublicWorkWeb;
  readonly tavily: SearchConfiguration | undefined;
  constructor(
    readonly transactions: WorkTransactions,
    readonly ledger: WorkLedger,
    readonly models: ModelConnections,
    options?: WorkWebOptions,
  ) {
    this.client = options?.client ?? new PublicWorkWeb();
    if (options?.tavilyKey !== undefined) {
      const key = options.tavilyKey.trim();
      this.tavily = { provider: "tavily", revision: sha256("openbot.host.tavily.v1\0" + key), key };
      searchSnapshot(this.tavily);
    }
  }
  private async searchConfiguration(
    db: WorkDb,
    scope: WorkScope,
  ): Promise<SearchConfiguration | null> {
    const source = await resourceWorkSource(db, scope, "web");
    if (this.tavily) return this.tavily;
    const selected = await this.models.resolve(db, source.selection);
    if (
      !selected ||
      selected.presetId !== "kimi" ||
      selected.protocol !== "openai-chat" ||
      !["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"].includes(selected.baseUrl)
    )
      return null;
    const { connectionId, revision, modelId, protocol, presetId, baseUrl } = selected;
    return {
      provider: "kimi",
      revision: String(revision),
      key: selected.apiKey,
      model: { connectionId, revision, modelId, protocol, presetId, baseUrl },
    };
  }
  async catalog(db: WorkDb, scope: WorkScope): Promise<Catalog> {
    const { task } = await resourceWorkSource(db, scope, "web"),
      search = await this.searchConfiguration(db, scope);
    return {
      sourceUrls: workSourceUrls(task.objective),
      searchProvider: search?.provider ?? null,
      maxWebCalls: 4,
    };
  }
  private async selected(db: WorkDb, scope: WorkScope, tool: string, raw: unknown) {
    const source = await resourceWorkSource(db, scope, "web");
    if (tool === "web_search") {
      const args = z.strictObject({ query: z.string() }).parse(raw);
      webQuery(args.query);
      const configuration = await this.searchConfiguration(db, scope);
      if (!configuration) throw new WorkConflict("work_web_search_unavailable");
      return {
        source,
        configuration,
        selection: { kind: "search", configuration: searchSnapshot(configuration) },
      };
    }
    let url: string;
    if (tool === "fetch")
      url = normalizeWorkSource(z.strictObject({ url: z.string() }).parse(raw).url);
    else if (tool === "read_public_page") {
      const args = z.strictObject({ sourceIndex: z.number().int().min(0).max(2) }).parse(raw),
        selected = workSourceUrls(source.task.objective)[args.sourceIndex];
      if (!selected) throw new WorkConflict("work_web_source_missing");
      url = selected;
    } else throw new WorkConflict("unknown_product_tool");
    return { source, configuration: null, selection: { kind: "page", url } };
  }
  private async checked(db: WorkDb, scope: WorkScope, intent: WorkAction["intent"]) {
    if (
      Object.keys(intent).sort().join(",") !== "arguments,effect,kind,tool" ||
      intent.kind !== "deferred_tool"
    )
      throw new WorkConflict("work_web_intent_changed");
    const effect = z
      .strictObject({
        kind: z.literal("product_web"),
        source: z.record(z.string(), z.json()),
        selection: z.record(z.string(), z.json()),
      })
      .parse(intent.effect);
    const fresh = await this.selected(db, scope, String(intent.tool), intent.arguments);
    if (
      workCanonical(effect.source).wire !== workCanonical(fresh.source.provenance).wire ||
      workCanonical(effect.selection).wire !== workCanonical(fresh.selection).wire
    )
      throw new WorkConflict("work_web_selection_changed");
    return fresh;
  }
  payload(action: WorkAction, observation: WorkJson | null) {
    const value = z
      .strictObject({
        schema: z.literal("openbot.work-web-ts/v1"),
        effectSha256: z.string(),
        payload: z.json(),
      })
      .parse(observation);
    if (value.effectSha256 !== workCanonical(action.intent.effect).digest)
      throw new WorkConflict("work_web_receipt_changed");
    return value.payload;
  }
  async revalidate(db: WorkDb, scope: WorkScope) {
    for (const action of await loadWorkActions(db, scope.binding.input.taskId)) {
      if (
        action.status !== "applied" ||
        action.correction_context_id !== scope.contextId ||
        !workWebNames.includes(action.intent.tool as (typeof workWebNames)[number])
      )
        continue;
      await this.checked(db, scope, action.intent);
      this.payload(action, await this.ledger.observed(db, action, "tool"));
    }
  }
  async execute(
    scope: WorkScope,
    key: string,
    call: WorkModelObservation["calls"][number],
    signal: AbortSignal,
  ) {
    const intent = await this.transactions.run(async (db) => {
      const fresh = await this.selected(db, scope, call.name, call.arguments);
      return {
        kind: "deferred_tool",
        tool: call.name,
        arguments: call.arguments,
        effect: {
          kind: "product_web",
          source: fresh.source.provenance,
          selection: z.json().parse(fresh.selection),
        },
      };
    });
    const action = await this.ledger.propose(scope, key, intent, 0, false);
    if (action.status === "applied" || action.decision === "pending") return;
    if (
      !(await this.ledger.admit(scope, action.id, async (db) => {
        await this.checked(db, scope, intent);
      }))
    )
      return;
    try {
      let selected: Awaited<ReturnType<WorkWeb["selected"]>> | undefined;
      await this.ledger.fresh(scope, action.id, async (db) => {
        selected = await this.checked(db, scope, intent);
        const prior =
          await db`SELECT payload FROM work_events WHERE task_id=${action.task_id} AND kind='tool.web_attempt_started'`;
        if (prior.length >= 4 || prior.some((p) => p.payload.actionId === action.id))
          throw new WorkConflict("work_web_call_limit");
        await workEvent(db, action.task_id, "tool.web_attempt_started", { actionId: action.id });
      });
      const beforeSend = () =>
        this.ledger.fresh(scope, action.id, async (db) => {
          const fresh = await this.checked(db, scope, intent);
          if (fresh.configuration?.key !== selected!.configuration?.key)
            throw new WorkConflict("work_web_configuration_changed");
          const rows =
            await db`SELECT kind FROM work_events WHERE task_id=${action.task_id} AND payload->>'actionId'=${action.id} AND kind IN ('tool.web_attempt_started','tool.web_dispatch_started')`;
          if (rows.length !== 1 || rows[0]!.kind !== "tool.web_attempt_started")
            throw new WorkConflict("work_web_already_dispatched");
          await workEvent(db, action.task_id, "tool.web_dispatch_started", { actionId: action.id });
        });
      const payload = selected!.configuration
        ? await this.client.search(
            webQuery((call.arguments as Record<string, WorkJson>).query),
            selected!.configuration,
            beforeSend,
            signal,
          )
        : await this.client.read(String(selected!.selection.url), beforeSend, signal);
      await this.ledger.record(scope.binding, action, "tool", {
        schema: "openbot.work-web-ts/v1",
        effectSha256: workCanonical(intent.effect).digest,
        payload,
      });
    } catch (error) {
      await this.ledger.unknown(scope.binding, action.id);
      throw error;
    }
  }
}
