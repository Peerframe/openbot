import { timingSafeEqual } from "node:crypto";
import { browserCommandSchema, nodeEnrollmentTokenSchema, nodeIdSchema } from "@openbot/protocol";
import { z } from "zod";
import { digest } from "./owner-auth-crypto.js";
import { ownerTransactions, refuse } from "./owner-transaction.js";
import {
  browserAuthority,
  browserHostIdentity,
  browserControlActive,
  browserControlState,
} from "./product-browser.js";
import { WorkerIdentities } from "./product-nodes.js";
import { runtimeSnapshotSchema, type RuntimeAccess } from "./runtime-port.js";
import { WorkerHostRegistry } from "./worker-host-registry.js";

import { workBrowserRoutesSchema } from "./work-browser-profiles.js";
import { loadWorkCommandConfiguration } from "./work-command-installation.js";
import { CommandInbox } from "./work-command-inbox.js";

const configuration = z.strictObject({
  browserRoutes: z
    .record(z.string().uuid(), nodeIdSchema)
    .refine((routes) => Object.keys(routes).length <= 32),
  pageOrigins: workBrowserRoutesSchema.shape.pageOrigins,
  command: z.string().min(1).max(4096).optional(),
  humanControl: z.boolean(),
  legacyHumanControl: z.boolean(),
});
export type WorkerRuntimeOptions = z.infer<typeof configuration>;
const dispatchSchema = z.strictObject({ ticketId: z.string().uuid(), wire: z.string().max(65536) });
const documentSchema = z.strictObject({
  frame: browserCommandSchema,
  binding: runtimeSnapshotSchema.shape.bindings.element,
});

/** In-process replacement for the P3 private Python port. It keeps original Owner authority,
 * the shared gate proof and durable one-use claim; socket ownership alone grants no effect. */
export class WorkerRuntime {
  readonly identities: WorkerIdentities;
  readonly registry: WorkerHostRegistry;
  readonly commandInbox: CommandInbox | undefined;
  private readonly commandConfig;
  private readonly owner;
  private readonly options: WorkerRuntimeOptions;
  private readonly stop = new AbortController();
  constructor(databaseUrl: string, options: WorkerRuntimeOptions) {
    this.options = configuration.parse(options);
    this.identities = new WorkerIdentities(databaseUrl);
    this.commandConfig = options.command
      ? loadWorkCommandConfiguration(options.command)
      : undefined;
    this.commandInbox = this.commandConfig ? new CommandInbox() : undefined;
    this.registry = new WorkerHostRegistry(this.identities, {}, this.commandInbox?.notifications);
    if (this.commandInbox) this.commandInbox.attach(this.registry.commands!);
    this.owner = ownerTransactions(databaseUrl);
  }
  commandConfiguration() {
    return this.commandConfig ? structuredClone(this.commandConfig) : undefined;
  }
  browserConfiguration() {
    return structuredClone({
      browserRoutes: this.options.browserRoutes,
      pageOrigins: this.options.pageOrigins,
    });
  }
  async close() {
    this.stop.abort();
    await this.registry.close();
    await this.identities.close();
    await this.owner.close();
  }
  access(token: string | undefined, _peer?: string): RuntimeAccess {
    const bounded = (signal: AbortSignal) => AbortSignal.any([signal, this.stop.signal]);
    return {
      snapshot: (signal) =>
        this.owner.run(token, bounded(signal), async () => {
          const nodes = this.registry.list();
          const snapshot = runtimeSnapshotSchema.parse({
            nodes,
            revision: this.registry.currentRevision,
            bindings: nodes
              .filter((node) =>
                node.capabilityManifest.some(
                  (cap) =>
                    cap.id === "browser.session" &&
                    cap.version === 1 &&
                    cap.providerId === "docker",
                ),
              )
              .map((node) => this.registry.browserBinding(node.id)),
            browserRoutes: this.options.browserRoutes,
            humanControl: this.options.humanControl,
            legacyHumanControl: this.options.legacyHumanControl,
          });
          if (Buffer.byteLength(JSON.stringify(snapshot)) > 4 * 1024 * 1024)
            return refuse(503, "worker_runtime_projection_limit");
          return snapshot;
        }),
      detach: async (id, enrollment, signal) => {
        const nodeId = nodeIdSchema.parse(id);
        if (enrollment !== undefined) {
          nodeEnrollmentTokenSchema.parse(enrollment);
          await this.identities.trusted(bounded(signal), async (db) => {
            if (
              !(
                await db`SELECT 1 FROM node_enrollment_tokens WHERE node_id=${nodeId} AND token_digest=${digest("openbot:enrollment:" + enrollment)} AND consumed_at IS NULL AND expires_at>clock_timestamp()`
              ).length
            )
              return refuse(401, "invalid_runtime_detach");
          });
        } else await this.owner.preflight(token, bounded(signal));
        // Enrollment/revocation already hold the identity fence. Taking it again deadlocks a
        // queued handshake; detach synchronously invalidates its original-connection bindings.
        this.registry.disconnect(nodeId);
      },
      command: (dispatch, signal) => this.command(token, dispatch, bounded(signal)),
    };
  }
  private async command(token: string | undefined, input: unknown, signal: AbortSignal) {
    await this.owner.preflight(token, signal);
    const { ticketId, wire } = dispatchSchema.parse(input);
    if (Buffer.byteLength(wire) > 65536) return refuse(422, "invalid_browser_dispatch");
    const { frame, binding } = documentSchema.parse(JSON.parse(wire));
    if (frame.action.kind === "agent" || frame.nodeId !== binding.nodeId)
      return refuse(422, "invalid_browser_dispatch");
    const proof = digest(`openbot:browser-dispatch:v1\0${token}\0${wire}`);
    const authority = async (
      db: Parameters<Parameters<typeof this.owner.run>[2]>[0],
      message: typeof frame,
    ) => {
      const [row] =
        await db`SELECT bot_id,node_id,payload FROM run_events WHERE id=${ticketId} AND type='BROWSER_TRANSPORT_ADMITTED'`;
      const stored = row?.payload?.proof;
      if (
        !row ||
        row.bot_id !== message.botId ||
        row.node_id !== message.nodeId ||
        typeof stored !== "string" ||
        !/^[a-f0-9]{64}$/.test(stored) ||
        !timingSafeEqual(Buffer.from(stored), Buffer.from(proof)) ||
        row.payload.requestId !== message.requestId
      )
        return refuse(403, "browser_dispatch_not_admitted");
      const { stamp, expiry } = await browserAuthority(db, message.botId, digest(token!));
      await browserHostIdentity(db, binding);
      const route = this.options.browserRoutes[message.botId] ?? null;
      if (row.payload.route !== route || (route !== null && route !== message.nodeId))
        return refuse(409, "browser_route_changed");
      const pid = row.payload.gatePid;
      if (!Number.isSafeInteger(pid) || pid < 1) return refuse(409, "browser_gate_expired");
      if (
        !(
          await db`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND pid=${pid} AND classid=1326850642
        AND objid=(hashtext(${message.botId})::bigint & 4294967295)::oid AND objsubid=2
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`
        ).length
      )
        return refuse(409, "browser_gate_expired");
      const remaining = Date.parse(message.expiresAt) - stamp.getTime();
      if (remaining <= 0 || remaining > 25100) return refuse(409, "browser_dispatch_expired");
      message.expiresAt = new Date(
        Math.min(Date.parse(message.expiresAt), expiry.getTime()),
      ).toISOString();
      const state = await browserControlState(db, message.botId),
        kind = message.action.kind;
      if (kind === "maintenance") {
        if (message.action.operation !== "status" && state.paused !== true)
          return refuse(409, "browser_control_required");
      } else if (kind !== "observe") {
        if (
          !this.options.legacyHumanControl &&
          !(this.options.humanControl && route === message.nodeId)
        )
          return refuse(503, "browser_agent_gate_not_configured");
        if (
          !state.paused ||
          state.sessionId !== message.sessionId ||
          !browserControlActive(state, stamp.getTime())
        )
          return refuse(409, "browser_control_required");
      }
      if (message.controlExpiresAt)
        message.controlExpiresAt = new Date(
          Math.min(Date.parse(message.controlExpiresAt), expiry.getTime()),
        ).toISOString();
    };
    // Commit the one-use request UUID before writing a socket. A lost reply cannot repeat it.
    await this.owner.run(token, signal, async (db) => {
      await authority(db, frame);
      if (
        !(
          await db`INSERT INTO run_events(id,bot_id,node_id,type,payload,created_at) VALUES(${frame.requestId},${frame.botId},${frame.nodeId},
        'BROWSER_TRANSPORT_CLAIMED',${db.json({ ticketId })},clock_timestamp()) ON CONFLICT(id) DO NOTHING RETURNING id`
        ).length
      )
        return refuse(409, "browser_dispatch_already_claimed");
    });
    return this.registry.browserCommand(
      frame,
      binding,
      async (message, bounded, send) => {
        await this.owner.run(token, bounded, async (db) => {
          await authority(db, message);
          await send();
        });
      },
      signal,
    );
  }
}
