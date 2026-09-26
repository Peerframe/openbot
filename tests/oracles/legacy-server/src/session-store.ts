export interface StoredOwnerSession {
  id: string;
  ownerId: "owner";
  tokenDigest: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateOwnerSessionInput {
  id: string;
  ownerId: "owner";
  tokenDigest: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface OwnerSessionStore {
  createSession(input: CreateOwnerSessionInput): Promise<StoredOwnerSession>;
  findActiveSession(tokenDigest: string, now: Date): Promise<StoredOwnerSession | undefined>;
  revokeSession(tokenDigest: string, now: Date): Promise<void>;
}
