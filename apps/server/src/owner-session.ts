/** Checks the existing Owner session inside the caller's transaction and lock order. */
import type postgres from "postgres";
import { createHash } from "node:crypto";
import { HttpFailure } from "./http-errors.js";

export function sessionDigest(token: string | undefined): string {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new HttpFailure(401, { error: "Authentication required." });
  return createHash("sha256").update(token, "ascii").digest("hex");
}
export async function findOwnerSession(
  db: postgres.TransactionSql,
  tokenDigest: string,
  share = false,
) {
  const rows = await db.unsafe<{ id: string; expires_at: Date; now: Date }[]>(
    "SELECT id,expires_at,clock_timestamp() AS now FROM auth_sessions " +
      "WHERE token_digest=$1 AND owner_id='owner' AND revoked_at IS NULL " +
      "AND expires_at>clock_timestamp()" + (share ? " FOR SHARE" : ""),
    [tokenDigest],
  );
  return rows[0];
}
export async function requireOwnerSession(
  db: postgres.TransactionSql,
  tokenDigest: string,
  share = false,
) {
  const session = await findOwnerSession(db, tokenDigest, share);
  if (!session) throw new HttpFailure(401, { error: "Authentication required." });
  return session;
}
