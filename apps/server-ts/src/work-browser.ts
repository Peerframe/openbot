import { browserPageSchema, protocolVersion, type BrowserCommand } from "@openbot/protocol";
import { z } from "zod";
import { WorkConflict } from "@openbot/work";
import type { DatabaseFence } from "./database-fence.js";
import { validateBrowserFrame } from "./product-browser.js";
import type { WorkerHostRegistry } from "./worker-host-registry.js";
import type { WorkBrowserProfiles } from "./work-browser-profiles.js";
import {
  browserAllowed,
  browserArguments,
  browserIntent,
  browserObservation,
  browserOperation,
  browserPayload,
  workBrowserNames,
} from "./work-browser-tools.js";
import { workEvent, type WorkDb, type WorkTransactions } from "./work-handoff.js";
import {
  currentWork,
  loadWorkActions,
  type WorkAction,
  type WorkLedger,
  type WorkScope,
} from "./work-ledger.js";
import type { WorkModelObservation } from "./work-model.js";
import { workTree } from "./work-tree.js";
import { workCanonical, type WorkJson } from "./work-values.js";
export type WorkBrowserServices = {
  profiles: WorkBrowserProfiles;
  registry: WorkerHostRegistry;
  gate: DatabaseFence;
};
const attemptKind = (page: boolean) =>
  page ? "tool.browser_page_started" : "tool.browser_capture_started";
/** One original-connection attempt. A durable unknown result is lookup-only, never a new screenshot or input. */
export class WorkBrowser {
  constructor(
    readonly transactions: WorkTransactions,
    readonly ledger: WorkLedger,
    readonly services: WorkBrowserServices,
  ) {}
  private async revision(db: WorkDb, botId: string) {
    const [row] =
      await db`SELECT id,payload FROM run_events WHERE bot_id=${botId} AND type='BROWSER_CONTROL_STATE' ORDER BY created_at DESC,id DESC LIMIT 1`;
    if (row && row.payload?.paused !== false) throw new WorkConflict("browser_paused");
    return row ? String(row.id) : null;
  }
  private async source(db: WorkDb, scope: WorkScope) {
    if (scope.browserProfiles !== this.services.profiles)
      throw new WorkConflict("browser_composition_required");
    const task = await currentWork(db, scope),
      profile = await this.services.profiles.resolve(db, task);
    return { task, ...profile };
  }
  private connection(source: Awaited<ReturnType<WorkBrowser["source"]>>, connectionId?: string) {
    const binding = this.services.registry.browserBinding(source.profile.nodeId);
    if (
      binding.credentialDigest !== source.profile.credentialDigest ||
      (connectionId && binding.connectionId !== connectionId)
    )
      throw new WorkConflict("browser_connection_changed");
    return binding;
  }
  private async attempts(
    db: WorkDb,
    taskId: string,
    page: boolean,
    action?: WorkAction,
    started = false,
  ) {
    const limit = page ? 16 : 4;
    const rows =
      await db`SELECT payload FROM work_events WHERE task_id=${taskId} AND kind=${attemptKind(page)} ORDER BY revision LIMIT ${limit + 1}`;
    const own = rows.filter((r) => r.payload.actionId === action?.id).map((r) => r.payload),
      expected = action ? { actionId: action.id, intentSha256: action.intent_digest } : null;
    if (
      started
        ? rows.length > limit || workCanonical(own).wire !== workCanonical([expected]).wire
        : rows.length >= limit || own.length
    )
      throw new WorkConflict("browser_attempt_limit");
  }
  private async evidence(db: WorkDb, scope: WorkScope, action: WorkAction) {
    const { effect } = browserIntent(action.intent),
      source = await this.source(db, scope);
    if (
      source.sha256 !== effect.profileSha256 ||
      (effect.kind === "work_browser_page" && source.page?.sha256 !== effect.scopeSha256)
    )
      throw new WorkConflict("browser_profile_changed");
    await this.attempts(db, action.task_id, effect.kind === "work_browser_page", action, true);
    const value = browserObservation(
      this.ledger.files,
      action,
      await this.ledger.observed(db, action, "tool"),
    );
    if (value.page && effect.kind === "work_browser_page")
      browserAllowed(value.page.url, source.page!.scope.origins, effect.operation.kind === "read");
    return value;
  }
  private async prior(
    db: WorkDb,
    scope: WorkScope,
    id: string,
    connectionId: string,
    revision: string | null,
  ) {
    const task = await currentWork(db, scope),
      row = (await loadWorkActions(db, task.id)).find(
        (a) =>
          a.id === id &&
          a.run_id === scope.binding.input.runId &&
          a.status === "applied" &&
          String(a.authority_generation) === String(task.authority_generation),
      );
    if (!row) throw new WorkConflict("browser_page_observation_required");
    const { effect } = browserIntent(row.intent);
    if (
      effect.kind !== "work_browser_page" ||
      effect.connectionId !== connectionId ||
      effect.controlRevision !== revision
    )
      throw new WorkConflict("browser_page_observation_stale");
    return this.evidence(db, { ...scope, contextId: row.correction_context_id }, row);
  }
  private async prepare(
    db: WorkDb,
    scope: WorkScope,
    name: keyof typeof browserArguments,
    args: Record<string, WorkJson>,
  ) {
    const source = await this.source(db, scope),
      binding = this.connection(source),
      revision = await this.revision(db, source.task.bot_id),
      page = name !== "capture_browser";
    await this.attempts(db, source.task.id, page);
    const common = {
      version: 1,
      profileSha256: source.sha256,
      connectionId: binding.connectionId,
      controlRevision: revision,
    };
    let effect: Record<string, WorkJson> = { kind: "work_browser_capture", ...common };
    if (page) {
      if (!source.page) throw new WorkConflict("browser_page_scope_required");
      let expected: WorkJson | undefined;
      if (name === "navigate_browser")
        browserAllowed(args.url as string, source.page.scope.origins);
      if (args.observationId) {
        const prior = await this.prior(
          db,
          scope,
          args.observationId as string,
          binding.connectionId,
          revision,
        );
        if (!prior.page) throw new WorkConflict("browser_page_observation_required");
        browserAllowed(prior.page.url, source.page.scope.origins);
        if (name === "click_browser" || name === "type_browser") {
          const element = prior.page.elements.find((e) => e.ref === args.ref);
          if (
            !element ||
            element.disabled ||
            (name === "type_browser" &&
              !["textbox", "searchbox", "combobox"].includes(element.role))
          )
            throw new WorkConflict("browser_page_element_unavailable");
        }
        expected = {
          url: prior.page.url,
          snapshotId: prior.page.snapshotId,
          frameSha256: prior.image.sha256,
        };
      }
      effect = {
        kind: "work_browser_page",
        ...common,
        scopeSha256: source.page.sha256,
        observationId: args.observationId ?? null,
        operation: browserOperation(name, args, expected),
      };
    }
    return { kind: "deferred_tool", tool: name, arguments: args, effect };
  }
  private async authorized(db: WorkDb, scope: WorkScope, action: WorkAction, started: boolean) {
    const { effect } = browserIntent(action.intent),
      source = await this.source(db, scope),
      binding = this.connection(source, effect.connectionId);
    if (
      effect.profileSha256 !== source.sha256 ||
      effect.controlRevision !== (await this.revision(db, source.task.bot_id)) ||
      !action.requires_approval ||
      action.decision !== "approved" ||
      !action.unexpired
    )
      throw new WorkConflict("browser_not_authorized");
    if (effect.kind === "work_browser_page") {
      if (effect.scopeSha256 !== source.page?.sha256)
        throw new WorkConflict("browser_page_scope_changed");
      if (effect.operation.kind === "navigate")
        browserAllowed(effect.operation.url, source.page.scope.origins);
      if (effect.observationId) {
        const prior = await this.prior(
          db,
          scope,
          effect.observationId,
          binding.connectionId,
          effect.controlRevision,
        );
        const expected = {
          url: prior.page!.url,
          snapshotId: prior.page!.snapshotId,
          frameSha256: prior.image.sha256,
        };
        if (
          !("expected" in effect.operation) ||
          workCanonical(effect.operation.expected).wire !== workCanonical(expected).wire
        )
          throw new WorkConflict("browser_page_observation_stale");
      }
    }
    await this.attempts(db, action.task_id, effect.kind === "work_browser_page", action, started);
    const [clock] =
      await db`SELECT clock_timestamp() AS now,least(c.expires_at,a.expires_at) AS expires FROM work_claims c JOIN work_runs r ON r.id=c.run_id AND r.execution_epoch=c.epoch JOIN work_actions a ON a.id=${action.id} WHERE r.id=${scope.binding.input.runId} AND c.claim_id=${scope.fence.claimId}`;
    if (!clock) throw new WorkConflict("execution_claim_required");
    const tree = workTree(source.task),
      expires = Math.min(
        clock.now.getTime() + 25000,
        clock.expires.getTime(),
        tree.deadline ? Date.parse(tree.deadline) : Infinity,
      );
    if (expires <= clock.now.getTime()) throw new WorkConflict("browser_expired");
    return { binding, expires, source };
  }
  async execute(
    scope: WorkScope,
    key: string,
    call: WorkModelObservation["calls"][number],
    signal: AbortSignal,
    validate: (db: WorkDb) => Promise<void>,
  ) {
    const name = call.name as keyof typeof browserArguments,
      args = browserArguments[name].parse(call.arguments) as Record<string, WorkJson>;
    const botId = await this.transactions.run(async (db) => (await currentWork(db, scope)).bot_id);
    return this.services.gate.run(botId, signal, async (bounded) => {
      const prior = await this.transactions.run(async (db) => {
        await currentWork(db, scope);
        return (await loadWorkActions(db, scope.binding.input.taskId)).find(
          (a) => a.action_key === key && a.run_id === scope.binding.input.runId,
        );
      });
      const intent =
        prior?.intent ??
        (await this.transactions.run(async (db) => {
          await validate(db);
          return this.prepare(db, scope, name, args);
        }));
      browserIntent(intent);
      if (intent.tool !== name || workCanonical(intent.arguments).wire !== workCanonical(args).wire)
        throw new WorkConflict("browser_intent_changed");
      const action = await this.ledger.propose(scope, key, intent, 0, true);
      if (action.status === "applied" || action.decision === "pending") return;
      if (
        !(await this.ledger.admit(scope, action.id, async (db, current) => {
          await validate(db);
          await this.authorized(db, scope, current, false);
        }))
      )
        return;
      try {
        let admission: Awaited<ReturnType<WorkBrowser["authorized"]>> | undefined;
        await this.ledger.fresh(scope, action.id, async (db, current) => {
          await validate(db);
          admission = await this.authorized(db, scope, current, false);
          await workEvent(
            db,
            action.task_id,
            attemptKind(browserIntent(intent).effect.kind === "work_browser_page"),
            { actionId: action.id, intentSha256: action.intent_digest },
          );
        });
        if (!admission) throw new WorkConflict("browser_not_authorized");
        const original = admission,
          { effect } = browserIntent(intent);
        const frame: BrowserCommand = {
          type: "browser.command",
          protocolVersion,
          nodeId: original.binding.nodeId,
          requestId: action.id,
          sessionId: action.task_id,
          botId,
          expiresAt: new Date(original.expires).toISOString(),
          action:
            effect.kind === "work_browser_page"
              ? { kind: "agent", operation: effect.operation }
              : { kind: "observe" },
        };
        const result = await this.services.registry.browserCommand(
          frame,
          original.binding,
          async (message, locked, send) => {
            await this.ledger.fresh(scope, action.id, async (db, current) => {
              locked.throwIfAborted();
              await validate(db);
              const fresh = await this.authorized(db, scope, current, true);
              message.expiresAt = new Date(Math.min(fresh.expires, original.expires)).toISOString();
              await send();
            });
          },
          bounded,
        );
        if (!result.ok) throw new WorkConflict("browser_unavailable");
        const observed = validateBrowserFrame(result.frame),
          page =
            effect.kind === "work_browser_page" ? browserPageSchema.parse(result.page) : undefined;
        if (page) {
          if (page.url !== observed.url) throw new WorkConflict("browser_page_changed");
          browserAllowed(
            page.url,
            original.source.page!.scope.origins,
            effect.kind === "work_browser_page" && effect.operation.kind === "read",
          );
        }
        const image = {
          ...this.ledger.files.put(Buffer.from(observed.base64, "base64")),
          width: observed.width,
          height: observed.height,
          capturedAt: observed.capturedAt,
        };
        const value = z.json().parse({
          schema: page ? "openbot.work-browser-page/v1" : "openbot.work-browser-capture/v1",
          image,
          payload: browserPayload(action.id, image, page),
        });
        browserObservation(this.ledger.files, action, value);
        await this.ledger.fresh(scope, action.id, async (db, current) => {
          await validate(db);
          await this.authorized(db, scope, current, true);
        });
        bounded.throwIfAborted();
        await this.ledger.record(scope.binding, action, "tool", value);
      } catch (error) {
        await this.ledger.unknown(scope.binding, action.id);
        throw error;
      }
    });
  }
  payload(action: WorkAction, value: WorkJson | null) {
    return browserObservation(this.ledger.files, action, value).payload;
  }
  async revalidate(db: WorkDb, scope: WorkScope) {
    const task = await currentWork(db, scope);
    for (const action of await loadWorkActions(db, task.id)) {
      if (
        action.run_id === scope.binding.input.runId &&
        String(action.authority_generation) === String(task.authority_generation) &&
        action.status === "applied" &&
        workBrowserNames.includes(action.intent.tool as never)
      )
        await this.evidence(db, { ...scope, contextId: action.correction_context_id }, action);
    }
  }
  async artifacts(db: WorkDb, scope: WorkScope) {
    const task = await currentWork(db, scope),
      artifacts = [];
    for (const action of await loadWorkActions(db, task.id)) {
      if (
        action.run_id !== scope.binding.input.runId ||
        String(action.authority_generation) !== String(task.authority_generation) ||
        action.status !== "applied" ||
        action.intent.tool !== "capture_browser"
      )
        continue;
      const { image } = await this.evidence(
        db,
        { ...scope, contextId: action.correction_context_id },
        action,
      );
      artifacts.push({
        key: action.id,
        name: "browser-" + action.id + ".png",
        mediaType: "image/png",
        sha256: image.sha256,
        sizeBytes: image.sizeBytes,
      });
    }
    return artifacts;
  }
}
