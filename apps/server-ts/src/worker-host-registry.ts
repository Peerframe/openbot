import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import {
  browserCommandSchema,
  commandProtocolVersion,
  parseCommandFrame,
  nodeMessageSchema,
  protocolVersion,
  serverMessageSchema,
  type BrowserResult,
  type ExecutionNodeWire,
  type NodeMessage,
  type RunOffer,
  type ServerMessage,
} from "@openbot/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { forbiddenHeader, safeRequestTarget } from "./config.js";
import type { WorkerIdentities } from "./product-nodes.js";
import type { RuntimeBinding } from "./runtime-port.js";

import {
  WorkerCommandChannel,
  type CommandHandle,
  type CommandNotifications,
} from "./worker-command-channel.js";
import { strictCommandJson } from "./work-command-values.js";

const payloadLimit = 32 * 1024 * 1024;
const stamp = () => new Date().toISOString();
const unavailable = () => new Error("worker_runtime_unavailable");
type Connection = {
  socket: WebSocket;
  phase: "hello" | "authenticating" | "live" | "closed";
  node?: ExecutionNodeWire;
  binding?: RuntimeBinding;
  commandHandle?: CommandHandle;
  stop: AbortController;
  enrolled: NodeJS.Timeout;
  ping: NodeJS.Timeout;
  alive: boolean;
  pendingBytes: number;
  pendingItems: number;
  incoming: Promise<void>;
  outgoing: Promise<void>;
  audited: boolean;
};
type OfferResult =
  | { status: "accepted" | "timeout" }
  | { status: "rejected" | "unavailable"; reason: string };
type Pending<T> = { connection: Connection; resolve: (value: T) => void };
export type WorkerNotifications = {
  available?: (node: ExecutionNodeWire) => void;
  updated?: (node: ExecutionNodeWire) => void;
  unavailable?: (node: ExecutionNodeWire) => void;
  run?: (node: ExecutionNodeWire, message: NodeMessage) => void;
};

/** Sole live socket owner. Authentication, reconnect and identity mutations share the SQL fence.
 * Notifications carry observations only; durable Work/Browser services retain all authority. */
export class WorkerHostRegistry {
  private readonly nodes = new Map<string, Connection>();
  private readonly connections = new Set<Connection>();
  private readonly pending = new Map<string, Pending<OfferResult> & { runId: string }>();
  private readonly browserPending = new Map<
    string,
    Pending<BrowserResult | null> & { sessionId: string }
  >();
  private readonly unavailableHandlers = new Set<(node: ExecutionNodeWire) => void>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly stop = new AbortController();
  private revision = 0;
  private socketServer?: WebSocketServer;
  private removeUpgrade?: () => void;
  readonly commands?: WorkerCommandChannel;
  constructor(
    readonly identities: Pick<WorkerIdentities, "authenticate" | "connectionEvent"> & {
      fence: Pick<WorkerIdentities["fence"], "run">;
    },
    private readonly notifications: WorkerNotifications = {},
    commandNotifications?: CommandNotifications,
  ) {
    if (commandNotifications) this.commands = new WorkerCommandChannel(commandNotifications);
  }
  list() {
    return [...this.nodes.values()].map((connection) => structuredClone(connection.node!));
  }
  get currentRevision() {
    return this.revision;
  }
  onBrowserUnavailable(handler: (node: ExecutionNodeWire) => void) {
    this.unavailableHandlers.add(handler);
    return () => this.unavailableHandlers.delete(handler);
  }
  private notify(kind: keyof WorkerNotifications, connection: Connection, message?: NodeMessage) {
    const handler = this.notifications[kind];
    if (!handler || !connection.node) return;
    // Even an accidentally async callback cannot block transport or silently grant authority.
    const result: unknown = handler(structuredClone(connection.node), structuredClone(message!));
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
      throw unavailable();
    }
  }
  private current(connection: Connection) {
    return (
      !this.stop.signal.aborted &&
      connection.phase === "live" &&
      !!connection.node &&
      this.nodes.get(connection.node.id) === connection
    );
  }
  private detach(connection: Connection, reason: string, notify = true) {
    if (!connection.node || this.nodes.get(connection.node.id) !== connection) return;
    if (connection.commandHandle) this.commands?.detach(connection.commandHandle);
    this.nodes.delete(connection.node.id);
    this.revision++;
    for (const [id, pending] of this.pending)
      if (pending.connection === connection) {
        this.pending.delete(id);
        pending.resolve({ status: "unavailable", reason });
      }
    for (const [id, pending] of this.browserPending)
      if (pending.connection === connection) {
        this.browserPending.delete(id);
        pending.resolve(null);
      }
    for (const handler of this.unavailableHandlers) {
      try {
        handler(structuredClone(connection.node));
      } catch {
        console.error("[openbot-worker] Browser disconnect notification unavailable.");
      }
    }
    if (notify) {
      try {
        this.notify("unavailable", connection);
      } catch {
        console.error("[openbot-worker] Disconnect notification unavailable.");
      }
    }
  }
  private closeConnection(connection: Connection, code = 1008, reason = "invalid-message") {
    this.detach(connection, "Node connection closed.");
    connection.phase = "closed";
    connection.stop.abort();
    clearTimeout(connection.enrolled);
    clearInterval(connection.ping);
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.close(code, reason);
      const timer = setTimeout(() => connection.socket.terminate(), 5000);
      timer.unref();
      connection.socket.once("close", () => clearTimeout(timer));
    } else if (connection.socket.readyState !== WebSocket.CLOSED) connection.socket.terminate();
  }
  private track<T>(operation: Promise<T>) {
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
    return operation;
  }
  private async send(connection: Connection, value: ServerMessage, requireCurrent = false) {
    const wire = JSON.stringify(serverMessageSchema.parse(value));
    await this.sendWire(connection, wire, () => {
      if (requireCurrent && !this.current(connection)) throw unavailable();
      if (value.type === "browser.command" && Date.parse(value.expiresAt) <= Date.now())
        throw unavailable();
    });
  }
  private async sendWire(connection: Connection, wire: string, check: () => void) {
    if (Buffer.byteLength(wire) > payloadLimit) throw unavailable();
    // The write budget includes queue time, so a stalled predecessor cannot extend a permit.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.closeConnection(connection, 1011, "send-unavailable");
        reject(unavailable());
      }, 5000);
    });
    const queued = connection.outgoing.then(async () => {
      if (
        connection.stop.signal.aborted ||
        connection.socket.readyState !== WebSocket.OPEN ||
        connection.socket.bufferedAmount > payloadLimit
      )
        throw unavailable();
      check();
      await new Promise<void>((resolve, reject) => {
        const aborted = () => finish(unavailable());
        const finish = (error?: Error | null) => {
          connection.stop.signal.removeEventListener("abort", aborted);
          error ? reject(error) : resolve();
        };
        connection.stop.signal.addEventListener("abort", aborted, { once: true });
        connection.socket.send(wire, finish);
      });
    });
    const outgoing = Promise.race([queued, timeout]).finally(() => clearTimeout(timer));
    connection.outgoing = outgoing.catch(() => {
      this.closeConnection(connection, 1011, "send-unavailable");
    });
    await outgoing;
  }
  private ack(connection: Connection, accepted: boolean, reason?: string, initial = false) {
    return this.send(connection, {
      type: "server.ack",
      protocolVersion,
      accepted,
      receivedAt: stamp(),
      ...(reason ? { reason } : {}),
      ...(initial && connection.commandHandle
        ? {
            commandChannel: {
              protocolVersion: commandProtocolVersion,
              connectionId: connection.binding!.connectionId,
            },
          }
        : {}),
    });
  }
  private async reject(connection: Connection, reason: string, closeReason: string) {
    try {
      await this.ack(connection, false, reason);
    } finally {
      this.closeConnection(connection, 1008, closeReason);
    }
  }
  private async authenticate(
    connection: Connection,
    hello: Extract<NodeMessage, { type: "node.hello" }>,
  ) {
    await this.identities.fence.run(hello.nodeId, connection.stop.signal, async (signal) => {
      const credentialDigest = await this.identities.authenticate(
        hello.nodeId,
        hello.credential,
        signal,
      );
      signal.throwIfAborted();
      if (connection.phase !== "authenticating" || this.stop.signal.aborted) throw unavailable();
      if (!credentialDigest) {
        await this.reject(
          connection,
          "Node credential is invalid or revoked.",
          "invalid-credential",
        );
        return;
      }
      const previous = this.nodes.get(hello.nodeId);
      if (previous) {
        this.detach(previous, "Node reconnected with a new socket.", false);
        this.closeConnection(previous, 1001, "node-reconnected");
      }
      const now = stamp();
      connection.node = {
        id: hello.nodeId,
        name: hello.name,
        platform: hello.platform,
        osVersion: hello.osVersion,
        architecture: hello.architecture,
        deviceClass: hello.deviceClass,
        isolation: hello.isolation,
        trustTier: hello.trustTier,
        capabilities: hello.capabilities,
        capabilityManifest: hello.capabilityManifest,
        maxConcurrentRuns: hello.maxConcurrentRuns,
        activeRunIds: [],
        connectedAt: now,
        lastSeenAt: now,
      };
      connection.binding = { nodeId: hello.nodeId, connectionId: randomUUID(), credentialDigest };
      await this.identities.connectionEvent(hello.nodeId, "connected", signal);
      connection.audited = true;
      signal.throwIfAborted();
      if (connection.phase !== "authenticating" || this.stop.signal.aborted) throw unavailable();
      connection.phase = "live";
      this.nodes.set(hello.nodeId, connection);
      this.revision++;
      clearTimeout(connection.enrolled);
      if (this.commands && hello.commandChannel)
        connection.commandHandle = this.commands.activate({
          binding: connection.binding!,
          current: () => this.current(connection),
          send: (wire, check) => this.sendWire(connection, wire, check),
          close: () => this.closeConnection(connection, 1008, "command-unavailable"),
          guard: (signal, operation) =>
            this.identities.fence.run(
              hello.nodeId,
              AbortSignal.any([signal, connection.stop.signal, this.stop.signal]),
              operation,
            ),
        });
      await this.ack(connection, true, undefined, true);
      this.notify("available", connection);
    });
  }
  private async receive(connection: Connection, wire: Buffer) {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(wire));
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      typeof value.type === "string" &&
      value.type.startsWith("work.command.")
    ) {
      if (
        !this.current(connection) ||
        !this.commands ||
        !connection.commandHandle ||
        wire.length > 32768
      )
        throw unavailable();
      const frame = await parseCommandFrame(strictCommandJson(wire, 32768), { server: false });
      this.commands.receive(connection.commandHandle, frame, wire.length);
      return;
    }
    const message = nodeMessageSchema.parse(value);
    if (connection.phase === "authenticating") {
      if (message.type !== "node.hello") throw unavailable();
      await this.authenticate(connection, message);
      return;
    }
    if (message.type === "node.hello") {
      await this.reject(connection, "A connection may authenticate only once.", "already-enrolled");
      return;
    }
    if (!this.current(connection) || message.nodeId !== connection.node!.id) throw unavailable();
    connection.node!.lastSeenAt = stamp();
    this.revision++;
    if (message.type === "node.heartbeat") {
      // Reported activeRunIds are observations, never assignments.
      this.notify("updated", connection);
    } else if (message.type === "browser.result") {
      const pending = this.browserPending.get(message.requestId);
      if (!pending) {
        await this.ack(connection, false, "Browser command is no longer pending.");
        return;
      }
      if (pending.connection !== connection || pending.sessionId !== message.sessionId)
        throw unavailable();
      this.browserPending.delete(message.requestId);
      pending.resolve(message);
    } else if (message.type === "run.accept" || message.type === "run.reject") {
      const pending = this.pending.get(message.offerId);
      if (!pending || pending.connection !== connection || pending.runId !== message.runId)
        throw unavailable();
      this.pending.delete(message.offerId);
      pending.resolve(
        message.type === "run.accept"
          ? { status: "accepted" }
          : { status: "rejected", reason: message.reason },
      );
    } else {
      if (!connection.node!.activeRunIds.includes(message.runId)) {
        await this.ack(connection, false, "Run is not assigned to this Node connection.");
        return;
      }
      this.notify("run", connection, message);
    }
    await this.ack(connection, true);
  }
  private accepted(socket: WebSocket) {
    const connection: Connection = {
      socket,
      phase: "hello",
      stop: new AbortController(),
      alive: true,
      pendingBytes: 0,
      pendingItems: 0,
      incoming: Promise.resolve(),
      outgoing: Promise.resolve(),
      audited: false,
      enrolled: setTimeout(
        () => this.closeConnection(connection, 1008, "enrollment-timeout"),
        10000,
      ),
      ping: setInterval(() => {
        if (!connection.alive) return this.closeConnection(connection, 1001, "heartbeat-timeout");
        connection.alive = false;
        socket.ping(undefined, undefined, (error) => {
          if (error) this.closeConnection(connection);
        });
      }, 30000),
    };
    connection.enrolled.unref();
    connection.ping.unref();
    this.connections.add(connection);
    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("error", () => this.closeConnection(connection));
    socket.on("message", (raw) => {
      if (connection.phase === "closed") return;
      // Arrival while SQL authenticates closes the original connection immediately. Never queue
      // pre-auth messages to be interpreted with authority acquired after their arrival.
      if (connection.phase === "authenticating")
        return this.closeConnection(connection, 1008, "pre-auth-message");
      if (connection.phase === "hello") connection.phase = "authenticating";
      const wire = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
      if (
        wire.length > payloadLimit ||
        connection.pendingItems >= 4 ||
        connection.pendingBytes + wire.length > payloadLimit
      ) {
        this.closeConnection(connection, 1009, "message-too-large");
        return;
      }
      connection.pendingItems++;
      connection.pendingBytes += wire.length;
      connection.incoming = connection.incoming
        .then(() => this.receive(connection, wire))
        .catch(async () => {
          if (connection.phase !== "closed") {
            try {
              await this.reject(connection, "Invalid node protocol message.", "invalid-message");
            } catch {
              this.closeConnection(connection);
            }
          }
        })
        .finally(() => {
          connection.pendingItems--;
          connection.pendingBytes -= wire.length;
        });
      this.track(connection.incoming);
    });
    socket.once("close", () => {
      this.closeConnection(connection);
      this.connections.delete(connection);
      this.track(
        connection.incoming.finally(async () => {
          if (connection.audited && connection.node) {
            try {
              await this.identities.connectionEvent(
                connection.node.id,
                "disconnected",
                AbortSignal.timeout(4000),
              );
            } catch {
              console.error("[openbot-worker] Disconnect audit unavailable.");
            }
          }
        }),
      );
    });
  }
  attach(server: Server | HttpsServer, publicOrigin: string) {
    if (this.socketServer || this.stop.signal.aborted) throw unavailable();
    const publicHost = new URL(publicOrigin).host;
    const sockets = new WebSocketServer({
      noServer: true,
      maxPayload: payloadLimit,
      perMessageDeflate: false,
    });
    this.socketServer = sockets;
    const upgrade = (incoming: IncomingMessage, client: Duplex, head: Buffer) => {
      client.on("error", () => client.destroy());
      const reject = (status: number) =>
        client.end(
          `HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          () => client.destroy(),
        );
      if (this.stop.signal.aborted || this.connections.size >= 32) {
        reject(503);
        return;
      }
      if (
        !safeRequestTarget(incoming.url) ||
        incoming.url.split("?")[0] !== "/ws/nodes" ||
        incoming.method !== "GET" ||
        incoming.headers.host !== publicHost ||
        Object.keys(incoming.headers).some(forbiddenHeader) ||
        incoming.headers.upgrade?.toLowerCase() !== "websocket" ||
        head.length > 65536
      ) {
        reject(400);
        return;
      }
      sockets.handleUpgrade(incoming, client, head, (socket) => this.accepted(socket));
    };
    server.on("upgrade", upgrade);
    this.removeUpgrade = () => server.off("upgrade", upgrade);
  }
  browserBinding(nodeId: string): RuntimeBinding {
    const connection = this.nodes.get(nodeId);
    if (!connection || !this.current(connection) || !this.capability(connection, "browser.session"))
      throw unavailable();
    return structuredClone(connection.binding!);
  }
  private capability(connection: Connection, id: string) {
    return connection.node!.capabilityManifest.some(
      (cap) => cap.id === id && cap.version === 1 && cap.providerId === "docker",
    );
  }
  private requireBinding(binding: RuntimeBinding) {
    const current = this.browserBinding(binding.nodeId);
    if (
      current.connectionId !== binding.connectionId ||
      current.credentialDigest !== binding.credentialDigest
    )
      throw unavailable();
    return this.nodes.get(binding.nodeId)!;
  }
  async browserCommand(
    input: unknown,
    binding: RuntimeBinding,
    guard: (
      frame: Extract<ServerMessage, { type: "browser.command" }>,
      signal: AbortSignal,
      send: () => Promise<void>,
    ) => Promise<void>,
    signal: AbortSignal,
  ): Promise<BrowserResult> {
    const frame = browserCommandSchema.parse(input),
      connection = this.requireBinding(binding);
    if (
      frame.nodeId !== binding.nodeId ||
      this.browserPending.size >= 64 ||
      this.browserPending.has(frame.requestId) ||
      ((frame.action.kind === "agent" || frame.action.kind === "maintenance") &&
        !this.capability(
          connection,
          frame.action.kind === "agent" ? "browser.page" : "browser.maintenance",
        ))
    )
      throw unavailable();
    let resolve!: (result: BrowserResult | null) => void;
    const result = new Promise<BrowserResult | null>((done) => {
      resolve = done;
    });
    const pending = { connection, sessionId: frame.sessionId, resolve };
    this.browserPending.set(frame.requestId, pending);
    const bounded = AbortSignal.any([
      signal,
      this.stop.signal,
      connection.stop.signal,
      AbortSignal.timeout(25100),
    ]);
    const aborted = () => resolve(null);
    bounded.addEventListener("abort", aborted, { once: true });
    let timer: NodeJS.Timeout | undefined,
      sent = false;
    try {
      await this.identities.fence.run(
        frame.nodeId,
        AbortSignal.any([bounded, AbortSignal.timeout(5000)]),
        async (locked) => {
          this.requireBinding(binding);
          await guard(frame, locked, async () => {
            if (sent) throw unavailable();
            sent = true;
            this.requireBinding(binding);
            locked.throwIfAborted();
            const remaining = Date.parse(frame.expiresAt) - Date.now();
            if (remaining <= 0 || remaining > 25100) throw unavailable();
            timer = setTimeout(() => resolve(null), remaining);
            await this.send(connection, frame, true);
          });
        },
      );
      bounded.throwIfAborted();
      if (!sent) throw unavailable();
      const observed = await result;
      this.requireBinding(binding);
      if (!observed) throw unavailable();
      return observed;
    } finally {
      if (timer) clearTimeout(timer);
      bounded.removeEventListener("abort", aborted);
      if (this.browserPending.get(frame.requestId) === pending)
        this.browserPending.delete(frame.requestId);
    }
  }
  async offerRun(
    nodeId: string,
    input: Omit<RunOffer, "type" | "protocolVersion" | "offerId" | "sentAt">,
  ): Promise<OfferResult> {
    const frame: RunOffer = {
      ...input,
      type: "run.offer",
      protocolVersion,
      offerId: randomUUID(),
      sentAt: stamp(),
    };
    const connection = this.nodes.get(nodeId);
    if (!connection || !this.current(connection))
      return { status: "unavailable", reason: "Node is not connected." };
    if (
      connection.node!.activeRunIds.length +
        [...this.pending.values()].filter((p) => p.connection === connection).length >=
      connection.node!.maxConcurrentRuns
    )
      return { status: "unavailable", reason: "Node is at capacity." };
    let resolve!: (result: OfferResult) => void;
    const result = new Promise<OfferResult>((done) => {
      resolve = done;
    });
    const pending = { connection, runId: frame.runId, resolve };
    this.pending.set(frame.offerId, pending);
    const timer = setTimeout(() => resolve({ status: "timeout" }), 10000);
    try {
      await this.send(connection, frame, true);
      return await result;
    } finally {
      clearTimeout(timer);
      if (this.pending.get(frame.offerId) === pending) this.pending.delete(frame.offerId);
    }
  }
  async confirmRun(nodeId: string, runId: string) {
    const connection = this.nodes.get(nodeId);
    if (!connection || !this.current(connection)) throw unavailable();
    if (!connection.node!.activeRunIds.includes(runId)) connection.node!.activeRunIds.push(runId);
    await this.send(
      connection,
      { type: "run.assigned", protocolVersion, nodeId, runId, assignedAt: stamp() },
      true,
    );
    this.revision++;
    this.notify("updated", connection);
  }
  async assignedCommand(nodeId: string, message: Extract<ServerMessage, { runId: string }>) {
    const connection = this.nodes.get(nodeId);
    if (
      !connection ||
      !this.current(connection) ||
      !connection.node!.activeRunIds.includes(message.runId)
    )
      throw unavailable();
    if (message.type === "run.settled" || message.type === "run.cancel") {
      connection.node!.activeRunIds = connection.node!.activeRunIds.filter(
        (id) => id !== message.runId,
      );
      this.revision++;
      this.notify("updated", connection);
    }
    await this.send(connection, message, true);
  }
  disconnect(nodeId: string) {
    const connection = this.nodes.get(nodeId);
    if (connection) this.closeConnection(connection, 1008, "credential-revoked");
  }
  async close() {
    this.stop.abort();
    this.removeUpgrade?.();
    for (const connection of this.connections)
      this.closeConnection(connection, 1012, "server-shutdown");
    await new Promise<void>((resolve) =>
      this.socketServer ? this.socketServer.close(() => resolve()) : resolve(),
    );
    await Promise.allSettled([...this.operations]);
  }
}
