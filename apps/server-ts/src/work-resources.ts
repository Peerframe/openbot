import { WorkBrowser, type WorkBrowserServices } from "./work-browser.js";
import { workBrowserNames } from "./work-browser-tools.js";
import { z } from "zod";
import {
  attachmentRead,
  attachmentReadRequest as request,
  pageWorkAttachment,
} from "./work-attachment.js";
export { attachmentReadTool, pageWorkAttachment } from "./work-attachment.js";
import { WorkMedia } from "./work-media.js";
import { channelReadNames, WorkChannelReads } from "./work-channel-reads.js";
import { WorkConflict } from "@openbot/work";
import type { ModelConnections } from "./model-connections.js";
import type { FileSession, OwnerFiles } from "./owner-files.js";
import type { PluginState } from "./plugin-values.js";
import type { Plugins } from "./product-plugins.js";
import { collaborationNames, WorkCollaboration } from "./work-collaboration.js";
import { acceptedWork } from "./work-execution.js";
import type { WorkDb, WorkTaskRow, WorkTransactions } from "./work-handoff.js";
import { knowledgeNames, WorkKnowledge } from "./work-knowledge.js";
import {
  currentWork,
  loadWorkActions,
  type WorkAction,
  type WorkLedger,
  type WorkScope,
} from "./work-ledger.js";
import type { WorkModelObservation, WorkTool } from "./work-model.js";
import { pluginWorkNames, WorkPlugins } from "./work-plugins.js";
import {
  resourceWorkSource,
  resolveWorkSource,
  sourceWorkAttachments,
  withWorkSource,
} from "./work-source.js";
import { type WorkJson, workCanonical } from "./work-values.js";
import { WorkWeb, type WorkWebOptions, workWebNames } from "./work-web.js";

import { WorkCommands } from "./work-command.js";
import type { WorkCommandSetup } from "./work-command-installation.js";

/** File lease always precedes SQL identity/Task locks, including model disclosure and publication. */
export class WorkResources {
  readonly media: WorkMedia;
  readonly browser: WorkBrowser | undefined;
  readonly commands: WorkCommands | undefined;
  readonly channel: WorkChannelReads;
  readonly collaboration: WorkCollaboration;
  readonly knowledge: WorkKnowledge;
  readonly plugins: WorkPlugins;
  readonly web: WorkWeb;
  constructor(
    readonly transactions: WorkTransactions,
    readonly ledger: WorkLedger,
    models: ModelConnections,
    readonly attachments?: OwnerFiles,
    plugins?: Plugins,
    web?: WorkWebOptions,
    browser?: WorkBrowserServices,
    command?: WorkCommandSetup,
  ) {
    this.commands = command
      ? new WorkCommands(transactions, ledger, command, attachments)
      : undefined;
    this.browser = browser ? new WorkBrowser(transactions, ledger, browser) : undefined;
    this.media = new WorkMedia(ledger.files);
    this.channel = new WorkChannelReads(transactions, ledger);
    this.collaboration = new WorkCollaboration(transactions, ledger);
    this.knowledge = new WorkKnowledge(transactions, ledger);
    this.plugins = new WorkPlugins(transactions, ledger, plugins);
    this.web = new WorkWeb(transactions, ledger, models, web);
  }
  lock<T>(
    operation: (session?: FileSession, plugins?: PluginState) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const run = (session?: FileSession) =>
      this.plugins.lock((state) => operation(session, state), signal);
    return this.attachments ? this.attachments.withLock(run, signal) : run();
  }
  run<T>(
    scope: WorkScope,
    operation: (db: WorkDb, plugins?: PluginState, session?: FileSession) => Promise<T>,
    publication = false,
  ) {
    return this.lock((session, plugins) =>
      this.transactions.run(async (db) => {
        if (publication) {
          const task = await acceptedWork(db, scope.binding);
          await db`SELECT id FROM bots WHERE id=${task.bot_id} FOR UPDATE`;
        }
        await this.revalidate(db, scope, session, plugins);
        return operation(db, plugins, session);
      }),
    );
  }
  private source(db: WorkDb, scope: WorkScope) {
    return resourceWorkSource(db, scope, "attachments");
  }
  private async checked(
    db: WorkDb,
    scope: WorkScope,
    session: FileSession | undefined,
    intent: WorkAction["intent"],
  ) {
    const args = request.parse(intent.arguments),
      effect = intent.effect as Record<string, WorkJson>;
    if (
      Object.keys(intent).sort().join(",") !== "arguments,effect,kind,tool" ||
      intent.kind !== "deferred_tool" ||
      intent.tool !== "read_attachment" ||
      !effect ||
      Object.keys(effect).sort().join(",") !== "attachment,kind,operation,source,version" ||
      effect.kind !== "work_reads" ||
      effect.version !== 1 ||
      effect.operation !== intent.tool
    )
      throw new WorkConflict("read_intent_changed");
    const source = await this.source(db, scope),
      read = attachmentRead(
        session,
        sourceWorkAttachments(source, source.task.objective, session),
        args,
      );
    if (
      workCanonical(effect.source).wire !== workCanonical(source.provenance).wire ||
      workCanonical(effect.attachment).wire !== workCanonical(read.snapshot).wire
    )
      throw new WorkConflict("read_source_changed");
    return { args, read, source };
  }
  async revalidate(db: WorkDb, scope: WorkScope, session?: FileSession, plugins?: PluginState) {
    return withWorkSource(db, scope, async (scope) => {
      const media = await this.media.validate(db, scope, session);
      await this.browser?.revalidate(db, scope);
      await this.commands?.revalidate(db, scope, session);
      await this.channel.revalidate(db, scope);
      await this.collaboration.revalidate(db, scope);
      await this.plugins.revalidate(db, scope, plugins);
      await this.web.revalidate(db, scope);
      await this.knowledge.revalidate(db, scope);
      const task = await currentWork(db, scope);
      sourceWorkAttachments(
        await resolveWorkSource(db, task, scope.browserProfiles, scope.commandProfiles),
        task.objective,
        session,
      );
      for (const action of await loadWorkActions(db, task.id)) {
        if (
          action.run_id === scope.binding.input.runId &&
          action.intent.kind === "model" &&
          workCanonical(action.intent.inputMedia ?? null).wire !==
            workCanonical(media.reference).wire
        )
          throw new WorkConflict("model_media_binding_changed");
        if (
          action.correction_context_id !== scope.contextId ||
          action.status !== "applied" ||
          action.intent.tool !== "read_attachment"
        )
          continue;
        const checked = await this.checked(db, scope, session, action.intent),
          observed = await this.ledger.observed(db, action, "tool");
        if (
          workCanonical(observed, 131072).wire !==
          workCanonical(this.envelope(action.intent, checked.read.page), 131072).wire
        )
          throw new WorkConflict("read_result_changed");
      }
    });
  }
  private envelope(intent: WorkAction["intent"], page: ReturnType<typeof pageWorkAttachment>) {
    const effect = intent.effect as Record<string, WorkJson>;
    return {
      kind: "work_reads",
      version: 1,
      operation: "read_attachment",
      result: page,
      receipt: { source: effect.source!, attachment: effect.attachment! },
    };
  }
  payload(action: WorkAction, observation: WorkJson | null) {
    if (action.intent.tool === "run_command") {
      if (!this.commands) throw new WorkConflict("command_composition_required");
      return this.commands.payload(action, observation);
    }
    if (workBrowserNames.includes(action.intent.tool as never)) {
      if (!this.browser) throw new WorkConflict("browser_composition_required");
      return this.browser.payload(action, observation);
    }
    if (channelReadNames.includes(action.intent.tool as never))
      return this.channel.payload(action, observation);
    if (collaborationNames.includes(action.intent.tool as (typeof collaborationNames)[number]))
      return this.collaboration.payload(action, observation);
    if (workWebNames.includes(action.intent.tool as (typeof workWebNames)[number]))
      return this.web.payload(action, observation);
    if (pluginWorkNames.includes(action.intent.tool as (typeof pluginWorkNames)[number]))
      return this.plugins.payload(action, observation);
    if (knowledgeNames.includes(action.intent.tool as (typeof knowledgeNames)[number]))
      return this.knowledge.payload(action, observation).payload;
    const value = z
      .object({
        kind: z.literal("work_reads"),
        version: z.literal(1),
        operation: z.literal("read_attachment"),
        result: z.record(z.string(), z.json()),
        receipt: z.record(z.string(), z.json()),
      })
      .strict()
      .parse(observation);
    const effect = action.intent.effect as Record<string, WorkJson>;
    if (
      workCanonical(value.receipt).wire !==
      workCanonical({ source: effect.source!, attachment: effect.attachment! }).wire
    )
      throw new WorkConflict("read_result_changed");
    return value.result;
  }
  async execute(
    scope: WorkScope,
    key: string,
    call: WorkModelObservation["calls"][number],
    signal: AbortSignal,
  ) {
    if (call.name === "run_command") {
      if (!this.commands) throw new WorkConflict("command_composition_required");
      return this.commands.execute(scope, key, call, signal);
    }
    if (workBrowserNames.includes(call.name as never)) {
      if (!this.browser) throw new WorkConflict("browser_composition_required");
      return this.lock(
        (session, plugins) =>
          this.browser!.execute(scope, key, call, signal, (db) =>
            this.revalidate(db, scope, session, plugins),
          ),
        signal,
      );
    }
    if (channelReadNames.includes(call.name as never))
      return this.channel.execute(scope, key, call);
    if (workWebNames.includes(call.name as (typeof workWebNames)[number]))
      return this.web.execute(scope, key, call, signal);
    if (pluginWorkNames.includes(call.name as (typeof pluginWorkNames)[number]))
      return this.plugins.execute(scope, key, call, signal);
    if (knowledgeNames.includes(call.name as (typeof knowledgeNames)[number]))
      return this.knowledge.execute(scope, key, call);
    if (call.name !== "read_attachment") throw new WorkConflict("unknown_product_tool");
    const args = request.parse(call.arguments);
    const intent = await this.lock((session) =>
      this.transactions.run(async (db) => {
        const source = await this.source(db, scope),
          read = attachmentRead(
            session,
            sourceWorkAttachments(source, source.task.objective, session),
            args,
          );
        return {
          kind: "deferred_tool",
          tool: call.name,
          arguments: args,
          effect: {
            kind: "work_reads",
            version: 1,
            operation: call.name,
            source: source.provenance,
            attachment: read.snapshot,
          },
        };
      }),
    );
    const action = await this.ledger.propose(scope, key, intent, 0, false);
    if (action.status === "applied" || action.decision === "pending") return;
    await this.lock(async (session) => {
      const validate = async (db: WorkDb) => {
        await this.checked(db, scope, session, intent);
      };
      if (!(await this.ledger.admit(scope, action.id, validate))) return;
      try {
        let observation: WorkJson | undefined;
        await this.ledger.fresh(scope, action.id, async (db) => {
          const checked = await this.checked(db, scope, session, intent),
            actions = (await loadWorkActions(db, action.task_id)).filter(
              (a) =>
                a.intent.tool === "read_attachment" &&
                ["admitted", "unknown", "applied"].includes(a.status),
            );
          if (actions.length > 32) throw new WorkConflict("attachment_read_budget_exhausted");
          let consumed = args.limit;
          for (const prior of actions.filter((a) => a.id !== action.id)) {
            const priorArgs = request.parse(prior.intent.arguments),
              value = await this.ledger.observed(db, prior, "tool");
            consumed +=
              value === null
                ? priorArgs.limit
                : z.object({ text: z.string() }).parse(this.payload(prior, value)).text.length;
          }
          if (consumed > 262144) throw new WorkConflict("attachment_read_budget_exhausted");
          observation = this.envelope(intent, checked.read.page);
        });
        if (!observation) throw new WorkConflict("read_observation_missing");
        await this.ledger.record(scope.binding, action, "tool", observation);
      } catch (error) {
        await this.ledger.unknown(scope.binding, action.id);
        throw error;
      }
    });
  }
}
