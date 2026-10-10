/** Authorizes human browser sessions and records bounded commands against the original runtime binding. */
import { LOCK_NAMESPACE } from "./database-locks.js";
import { requireOwnerSession } from "./owner-session.js";
import { databasePool } from "./database-pool.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import {
  browserOwnerActionHttpSchema,
  browserMaintenanceRequestSchema,
  browserFrameHttpSchema,
  browserRuntimeStateSchema,
  browserSessionHttpSchema,
  type BrowserCommand,
} from "@openbot/protocol";
import { DatabaseFence } from "./database-fence.js";
import type { RuntimeAccess, RuntimeBinding, RuntimeSnapshot } from "./worker-runtime-contracts.js";
import { refuse } from "./owner-transaction.js";
import { HttpFailure } from "./http-errors.js";
import type {
  AuthorizedProductOperation,
  ProductRequest,
  ProductRoute,
} from "./product-identity.js";

type DB = postgres.TransactionSql;
type State = { paused: boolean; sessionId?: string; expiresAt?: string };
type Session = {
  id: string;
  botId: string;
  nodeId: string;
  nodeName: string;
  owner: string;
  expires: number;
  binding: RuntimeBinding;
  route: string | null;
};
const minimum = (...dates: Date[]) =>
  new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const active = (state: State, now = Date.now()) =>
  Boolean(state.sessionId && state.expiresAt && Date.parse(state.expiresAt) > now);
const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const value = schema.safeParse(body);
  return value.success ? value.data : refuse(422, "Invalid browser input.");
};
async function state(db: DB, botId: string): Promise<State> {
  const [row] =
    await db`SELECT payload FROM run_events WHERE bot_id=${botId} AND type='BROWSER_CONTROL_STATE' ORDER BY created_at DESC,id DESC LIMIT 1`;
  return row?.payload ?? { paused: false };
}
async function saveState(db: DB, session: Session, value: State) {
  await db`INSERT INTO run_events(id,bot_id,node_id,type,payload,created_at) VALUES(${randomUUID()},${session.botId},${session.nodeId},'BROWSER_CONTROL_STATE',${db.json(value as postgres.JSONValue)},clock_timestamp())`;
}
async function event(db: DB, session: Session, requestId: string, action: string, phase: string) {
  await db`INSERT INTO run_events(id,bot_id,node_id,type,payload,created_at) VALUES(${randomUUID()},${session.botId},${session.nodeId},${action === "open" ? "BROWSER_OPENED" : "BROWSER_COMMAND"},${db.json({ actor: "owner", requestId, action, phase })},clock_timestamp())`;
}
async function authority(db: DB, botId: string, ownerDigest: string) {
  const [bot] =
    await db`SELECT computer_profile FROM bots WHERE id=${botId} AND deleted_at IS NULL FOR SHARE`;
  if (!bot) return refuse(404, "browser_employee_not_found");
  if (bot.computer_profile !== "docker-linux")
    return refuse(403, "browser_employee_profile_changed");
  const clock = await requireOwnerSession(db, ownerDigest);
  return { stamp: clock.now as Date, expiry: clock.expires_at as Date };
}
async function hostIdentity(db: DB, binding: RuntimeBinding) {
  const [row] =
    await db`SELECT credential_digest,revoked_at FROM node_credentials WHERE node_id=${binding.nodeId} FOR SHARE`;
  if (!row || row.revoked_at !== null || row.credential_digest !== binding.credentialDigest)
    return refuse(409, "browser_host_identity_changed");
}
export function validateBrowserFrame(input: unknown) {
  const frame = browserFrameHttpSchema.parse(input),
    data = Buffer.from(frame.base64, "base64");
  if (
    data.length < 24 ||
    data.length > 5 * 1024 * 1024 ||
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    data.readUInt32BE(16) !== frame.width ||
    data.readUInt32BE(20) !== frame.height
  )
    throw new Error("Invalid browser frame.");
  return frame;
}
export class BrowserSessions {
  private readonly pool: ReturnType<typeof databasePool>;
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Set<string>();
  private readonly gate: DatabaseFence;
  private readonly trusted;
  private closed = false;
  constructor(databaseUrl: string) {
    this.gate = new DatabaseFence(databaseUrl, LOCK_NAMESPACE.browser, 35000, "browser_busy");
    this.pool = databasePool(databaseUrl);
    this.trusted = this.pool.sql;
  }
  async close() {
    this.closed = true;
    this.sessions.clear();
    await this.gate.close();
    await this.pool.close();
  }
  private session(id: string, request: ProductRequest) {
    const session = this.sessions.get(id);
    if (
      this.closed ||
      !session ||
      session.expires <= Date.now() ||
      session.owner !== request.ownerDigest
    )
      return refuse(404, "browser_view_expired");
    return session;
  }
  private async runtime(request: ProductRequest, signal: AbortSignal) {
    if (!request.runtime) return refuse(503, "worker_runtime_unavailable");
    const live = await request.runtime.snapshot(signal);
    for (const [id, session] of this.sessions)
      if (!live.bindings.some((binding) => same(binding, session.binding)))
        this.sessions.delete(id);
    return live;
  }
  private route(session: Session, live: RuntimeSnapshot, kind: string) {
    const current = live.browserRoutes[session.botId] ?? null;
    if (current !== session.route || (current !== null && current !== session.nodeId))
      return refuse(409, "browser_route_changed");
    if (kind !== "observe" && !this.control(session, live))
      return refuse(503, "browser_agent_gate_not_configured");
  }
  private control(session: Session, live: RuntimeSnapshot) {
    return (
      live.legacyHumanControl ||
      (live.humanControl && live.browserRoutes[session.botId] === session.nodeId)
    );
  }
  private binding(session: Session, live: RuntimeSnapshot) {
    if (!live.bindings.some((binding) => same(binding, session.binding)))
      return refuse(409, "browser_host_connection_changed");
  }
  private view(session: Session, value: State, live: RuntimeSnapshot) {
    return browserSessionHttpSchema.parse({
      id: session.id,
      botId: session.botId,
      nodeId: session.nodeId,
      nodeName: session.nodeName,
      controlAvailable: this.control(session, live),
      control: active(value)
        ? value.sessionId === session.id
          ? "mine"
          : "other"
        : value.paused
          ? "paused"
          : "available",
      ...(value.expiresAt ? { controlExpiresAt: value.expiresAt } : {}),
    });
  }
  async open(
    owner: AuthorizedProductOperation,
    botId: string,
    request: ProductRequest,
    signal: AbortSignal,
  ) {
    parse(z.string().uuid(), botId);
    for (const [id, session] of this.sessions)
      if (session.expires <= Date.now()) this.sessions.delete(id);
    if (this.closed || this.sessions.size + this.opening.size >= 64 || this.opening.has(botId))
      return refuse(409, "browser_busy");
    this.opening.add(botId);
    try {
      return await this.gate.run(botId, signal, async (bounded) => {
        const live = await this.runtime(request, bounded);
        const { session, value } = await owner(async (db) => {
          await authority(db, botId, request.ownerDigest!);
          const [bound] =
            await db`SELECT node_id,payload FROM run_events WHERE bot_id=${botId} AND type='BROWSER_HOST_BOUND' ORDER BY created_at DESC,id DESC LIMIT 1`;
          const [old] = bound
            ? [bound]
            : await db`SELECT node_id FROM run_events WHERE bot_id=${botId} AND type='BROWSER_OPENED' ORDER BY created_at DESC,id DESC LIMIT 1`;
          const [run] = old
            ? [old]
            : await db`SELECT node_id FROM runs WHERE bot_id=${botId} AND node_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
          const previous = run?.node_id ?? null,
            route = live.browserRoutes[botId] ?? null;
          if (previous && route && previous !== route) return refuse(409, "browser_route_changed");
          const selected = previous ?? route;
          const node = [...live.nodes]
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .find(
              (node) =>
                (!selected || node.id === selected) &&
                node.capabilityManifest.some(
                  (cap) =>
                    cap.id === "browser.session" &&
                    cap.version === 1 &&
                    cap.providerId === "docker",
                ),
            );
          if (!node)
            return refuse(
              503,
              previous ? "browser_original_host_unavailable" : "browser_host_unavailable",
            );
          const binding = live.bindings.find((binding) => binding.nodeId === node.id);
          if (!binding) return refuse(503, "browser_host_unavailable");
          await hostIdentity(db, binding);
          if (bound && !same(bound.payload, { credentialDigest: binding.credentialDigest }))
            return refuse(409, "browser_host_identity_changed");
          if (!bound && previous) return refuse(409, "browser_original_host_identity_unverified");
          await db`INSERT INTO nodes(id,name,platform,capabilities,capability_manifest,status) VALUES(${node.id},${node.name},${node.platform},${db.json(node.capabilities)},${db.json(node.capabilityManifest)},'online') ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,platform=EXCLUDED.platform,capabilities=EXCLUDED.capabilities,capability_manifest=EXCLUDED.capability_manifest`;
          const session: Session = {
            id: randomUUID(),
            botId,
            nodeId: node.id,
            nodeName: node.name,
            owner: request.ownerDigest!,
            expires: Date.now() + 600000,
            binding,
            route,
          };
          if (!bound)
            await db`INSERT INTO run_events(id,bot_id,node_id,type,payload,created_at) VALUES(${randomUUID()},${botId},${node.id},'BROWSER_HOST_BOUND',${db.json({ credentialDigest: binding.credentialDigest })},clock_timestamp())`;
          await event(db, session, randomUUID(), "open", "completed");
          return { session, value: await state(db, botId) };
        }, bounded);
        const after = await this.runtime(request, bounded);
        this.binding(session, after);
        if (this.closed) return refuse(503, "browser_host_unavailable");
        this.sessions.set(session.id, session);
        return this.view(session, value, after);
      });
    } finally {
      this.opening.delete(botId);
    }
  }
  private async ticket(
    db: DB,
    session: Session,
    frame: BrowserCommand,
    request: ProductRequest,
    pid: number,
  ) {
    const ticketId = randomUUID(),
      wire = JSON.stringify({ frame, binding: session.binding });
    await db`INSERT INTO run_events(id,bot_id,node_id,type,payload,created_at) VALUES(${ticketId},${session.botId},${session.nodeId},'BROWSER_TRANSPORT_ADMITTED',${db.json({ proof: request.dispatchProof!(wire), requestId: frame.requestId, route: session.route, gatePid: pid })},clock_timestamp())`;
    return { ticketId, wire };
  }
  async command(
    owner: AuthorizedProductOperation,
    id: string,
    body: unknown,
    request: ProductRequest,
    signal: AbortSignal,
  ) {
    const action = parse(browserOwnerActionHttpSchema, body);
    let live = await this.runtime(request, signal);
    const session = this.session(id, request),
      kind = action.kind,
      requestId = randomUUID();
    this.route(session, live, kind);
    return this.gate.run(session.botId, signal, async (bounded, pid) => {
      this.session(id, request);
      live = await this.runtime(request, bounded);
      this.binding(session, live);
      const prepared = await owner(async (db) => {
        const { stamp, expiry } = await authority(db, session.botId, session.owner);
        await hostIdentity(db, session.binding);
        this.route(session, live, kind);
        let value = await state(db, session.botId);
        const held = active(value, stamp.getTime());
        if (kind === "take") {
          if (held && value.sessionId !== id) return refuse(409, "browser_control_held_elsewhere");
          value = {
            paused: true,
            sessionId: id,
            expiresAt: minimum(new Date(stamp.getTime() + 30000), expiry),
          };
        } else if (kind !== "observe" && (!held || value.sessionId !== id))
          return refuse(409, "browser_control_required");
        else if (held && value.sessionId === id)
          value = { ...value, expiresAt: minimum(new Date(stamp.getTime() + 30000), expiry) };
        if (kind === "take" || (held && value.sessionId === id))
          await saveState(db, session, value);
        if (kind !== "observe") await event(db, session, requestId, kind, "intent");
        const frame: BrowserCommand = {
          type: "browser.command",
          protocolVersion: "0.9.0",
          nodeId: session.nodeId,
          botId: session.botId,
          sessionId: id,
          requestId,
          expiresAt: minimum(new Date(stamp.getTime() + 25000), expiry),
          action,
          ...(value.sessionId === id && active(value)
            ? { controlExpiresAt: value.expiresAt! }
            : {}),
        };
        return { value, dispatch: await this.ticket(db, session, frame, request, pid) };
      }, bounded);
      let value = prepared.value;
      try {
        // Once admitted, retain the human/agent gate until the original bounded command settles,
        // including a disconnected viewer. Aborting HTTP is never an effect cancellation/retry.
        const result = await request.runtime!.command(
          prepared.dispatch,
          AbortSignal.timeout(30000),
        );
        if (!result.ok || !result.frame) throw new Error("Unconfirmed browser operation.");
        const observed = validateBrowserFrame(result.frame);
        live = await this.runtime(request, bounded);
        await owner(async (db) => {
          await authority(db, session.botId, session.owner);
          this.session(id, request);
          await hostIdentity(db, session.binding);
          this.binding(session, live);
          this.route(session, live, kind);
          if (kind !== "observe") await event(db, session, requestId, kind, "completed");
          if (kind === "release") {
            value = { paused: false };
            await saveState(db, session, value);
          }
        }, bounded);
        session.expires = Date.now() + 600000;
        return { ...this.view(session, value, live), frame: observed };
      } catch (error) {
        if (kind !== "observe")
          await this.trusted.begin(async (db) => {
            await event(db, session, requestId, kind, "uncertain");
            if (value.sessionId === id)
              await saveState(db, session, {
                paused: true,
                sessionId: id,
                expiresAt: new Date().toISOString(),
              });
          });
        throw error;
      }
    });
  }
  async maintenance(
    owner: AuthorizedProductOperation,
    botId: string,
    body: unknown,
    request: ProductRequest,
    signal: AbortSignal,
  ) {
    parse(z.string().uuid(), botId);
    const action = parse(browserMaintenanceRequestSchema, body),
      initial = await this.runtime(request, signal);
    await owner(async (db) => {
      await authority(db, botId, request.ownerDigest!);
      if (
        !(
          await db`SELECT 1 FROM run_events WHERE bot_id=${botId} AND type='BROWSER_HOST_BOUND' LIMIT 1`
        ).length &&
        !initial.browserRoutes[botId]
      )
        return refuse(503, "browser_original_host_required");
    });
    const view = await this.open(owner, botId, request, signal),
      session = this.session(view.id, request),
      requestId = randomUUID(),
      operation = action.operation;
    try {
      return await this.gate.run(botId, signal, async (bounded, pid) => {
        let live = await this.runtime(request, bounded);
        this.binding(session, live);
        const prepared = await owner(async (db) => {
          const { stamp, expiry } = await authority(db, botId, session.owner);
          await hostIdentity(db, session.binding);
          this.route(session, live, "observe");
          const node = live.nodes.find((node) => node.id === session.nodeId);
          if (
            !node?.capabilityManifest.some(
              (cap) =>
                cap.id === "browser.maintenance" &&
                cap.version === 1 &&
                cap.providerId === "docker",
            )
          )
            return refuse(503, "browser_maintenance_unavailable");
          if (operation !== "status") {
            await saveState(db, session, { paused: true });
            await event(db, session, requestId, operation, "intent");
          }
          const frame: BrowserCommand = {
            type: "browser.command",
            protocolVersion: "0.9.0",
            nodeId: session.nodeId,
            botId,
            sessionId: session.id,
            requestId,
            expiresAt: minimum(new Date(stamp.getTime() + 25000), expiry),
            action: { kind: "maintenance", operation },
          };
          return {
            value: await state(db, botId),
            dispatch: await this.ticket(db, session, frame, request, pid),
          };
        }, bounded);
        if (operation !== "status")
          for (const [id, other] of this.sessions)
            if (other.botId === botId && id !== session.id) this.sessions.delete(id);
        try {
          const result = await request.runtime!.command(
            prepared.dispatch,
            AbortSignal.timeout(30000),
          );
          if (!result.ok || !result.runtime) throw new Error("Unconfirmed browser maintenance.");
          const runtime = browserRuntimeStateSchema.parse(result.runtime);
          if (
            (operation === "restart" && !runtime.running) ||
            (operation === "clear" && runtime.running)
          )
            throw new Error("Unexpected browser runtime state.");
          live = await this.runtime(request, bounded);
          this.binding(session, live);
          await owner(async (db) => {
            await authority(db, botId, session.owner);
            await hostIdentity(db, session.binding);
            this.route(session, live, "observe");
            if (operation !== "status") await event(db, session, requestId, operation, "completed");
          }, bounded);
          return {
            botId,
            nodeId: session.nodeId,
            ...runtime,
            paused: prepared.value.paused === true,
          };
        } catch (error) {
          if (operation !== "status")
            await this.trusted.begin((db) => event(db, session, requestId, operation, "uncertain"));
          throw error;
        }
      });
    } finally {
      this.sessions.delete(session.id);
    }
  }
  async closeView(
    owner: AuthorizedProductOperation,
    id: string,
    request: ProductRequest,
    signal: AbortSignal,
  ) {
    await this.runtime(request, signal);
    const session = this.session(id, request);
    await this.gate.run(session.botId, signal, async (bounded) => {
      await owner(async (db) => {
        const value = await state(db, session.botId);
        if (value.sessionId === id)
          await saveState(db, session, {
            paused: true,
            sessionId: id,
            expiresAt: new Date().toISOString(),
          });
      }, bounded);
      this.sessions.delete(id);
    });
  }
}
export function browserRoutes(service: BrowserSessions): ProductRoute[] {
  const wrap = (operation: () => Promise<unknown>) =>
    operation().catch((error) => {
      if (error instanceof HttpFailure) throw error;
      return refuse(
        503,
        "Browser operation was not confirmed; input is never retried automatically.",
      );
    });
  const execute = async () => {
    throw new Error("Browser requires live runtime.");
  };
  return [
    {
      method: "POST",
      path: "/api/v1/bots/{bot_id}/browser",
      kind: "product",
      maxBytes: 0,
      status: 201,
      execute,
      remote: (owner, ids, _body, signal, request) =>
        wrap(() => service.open(owner, ids[0]!, request, signal)),
    },
    {
      method: "POST",
      path: "/api/v1/bots/{bot_id}/browser/maintenance",
      kind: "typed",
      maxBytes: 1024,
      execute,
      remote: (owner, ids, body, signal, request) =>
        wrap(() => service.maintenance(owner, ids[0]!, body, request, signal)),
    },
    {
      method: "POST",
      path: "/api/v1/browser-sessions/{session_id}/commands",
      kind: "typed",
      maxBytes: 20000,
      execute,
      remote: (owner, ids, body, signal, request) =>
        wrap(() => service.command(owner, ids[0]!, body, request, signal)),
    },
    {
      method: "DELETE",
      path: "/api/v1/browser-sessions/{session_id}",
      kind: "product",
      maxBytes: 0,
      status: 204,
      execute,
      remote: (owner, ids, _body, signal, request) =>
        wrap(() => service.closeView(owner, ids[0]!, request, signal)),
    },
  ];
}

// The sole Worker transport reuses these SQL checks at the final dispatch boundary.
export {
  authority as browserAuthority,
  hostIdentity as browserHostIdentity,
  state as browserControlState,
  active as browserControlActive,
};
