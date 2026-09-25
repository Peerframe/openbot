import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  CreateNodeEnrollmentTokenInput,
  ExchangeNodeEnrollmentInput,
  NodeEnrollmentResult,
} from "@openbot/protocol";
import type { ClientIdentity } from "./client-identity.js";

export interface StoredNodeEnrollmentToken {
  id: string;
  nodeId: string;
  tokenDigest: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface ExchangeNodeEnrollmentRecord {
  nodeId: string;
  tokenDigest: string;
  credentialDigest: string;
  enrolledAt: Date;
  clientIdentityDigest: string;
  clientIdentitySource: ClientIdentity["source"];
}

export interface StoredNodeIdentity {
  nodeId: string;
  enrolledAt: Date;
  lastAuthenticatedAt: Date | null;
  revokedAt: Date | null;
}

export interface NodeIdentityStore {
  replaceEnrollmentToken(record: StoredNodeEnrollmentToken): Promise<void>;
  exchangeEnrollmentToken(record: ExchangeNodeEnrollmentRecord): Promise<boolean>;
  authenticateCredential(nodeId: string, credentialDigest: string, now: Date): Promise<boolean>;
  revokeCredential(nodeId: string, now: Date): Promise<boolean>;
  listCredentials(): Promise<StoredNodeIdentity[]>;
}

export interface IssuedNodeEnrollmentToken {
  nodeId: string;
  token: string;
  expiresAt: string;
}

export class InvalidNodeEnrollmentError extends Error {}
export class NodeIdentityNotFoundError extends Error {}

/** Owns the one-time bootstrap exchange while PostgreSQL remains the identity source of truth. */
export class NodeIdentityService {
  readonly #store: NodeIdentityStore;
  readonly #now: () => Date;

  constructor(store: NodeIdentityStore, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  async issueEnrollmentToken(
    input: CreateNodeEnrollmentTokenInput,
  ): Promise<IssuedNodeEnrollmentToken> {
    const now = this.#now();
    const token = `obenr_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now.getTime() + input.expiresInSeconds * 1000);
    await this.#store.replaceEnrollmentToken({
      id: randomUUID(),
      nodeId: input.nodeId,
      tokenDigest: digestNodeSecret("enrollment", token),
      expiresAt,
      createdAt: now,
    });
    return { nodeId: input.nodeId, token, expiresAt: expiresAt.toISOString() };
  }

  async enroll(
    input: ExchangeNodeEnrollmentInput,
    clientIdentity: ClientIdentity,
  ): Promise<NodeEnrollmentResult> {
    const enrolledAt = this.#now();
    const credential = `obn_${randomBytes(32).toString("base64url")}`;
    const exchanged = await this.#store.exchangeEnrollmentToken({
      nodeId: input.nodeId,
      tokenDigest: digestNodeSecret("enrollment", input.token),
      credentialDigest: digestNodeSecret("credential", credential),
      enrolledAt,
      clientIdentityDigest: clientIdentity.digest,
      clientIdentitySource: clientIdentity.source,
    });
    if (!exchanged) {
      throw new InvalidNodeEnrollmentError("Node enrollment token is invalid or expired.");
    }
    return {
      format: "openbot.node-identity/v1",
      nodeId: input.nodeId,
      credential,
      enrolledAt: enrolledAt.toISOString(),
    };
  }

  authenticate(nodeId: string, credential: string): Promise<boolean> {
    return this.#store.authenticateCredential(
      nodeId,
      digestNodeSecret("credential", credential),
      this.#now(),
    );
  }

  list(): Promise<StoredNodeIdentity[]> {
    return this.#store.listCredentials();
  }

  async revoke(nodeId: string): Promise<void> {
    if (!(await this.#store.revokeCredential(nodeId, this.#now()))) {
      throw new NodeIdentityNotFoundError("Active Node identity not found.");
    }
  }
}

export function digestNodeSecret(kind: "credential" | "enrollment", secret: string): string {
  return createHash("sha256").update(`openbot:${kind}:`).update(secret).digest("hex");
}
