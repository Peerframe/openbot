// Reads the Owner's sign-in session at start-up and, on a local Desktop host, restores it once.
import type { AuthSessionSnapshot } from "@openbot/domain";

/** Recover identity only; never replay the operation that received HTTP 401. */
export async function resolveAuthSession(
  read: (signal?: AbortSignal) => Promise<AuthSessionSnapshot>,
  restore?: () => Promise<Readonly<{ status: "restored" | "unavailable" }>>,
  signal?: AbortSignal,
): Promise<AuthSessionSnapshot> {
  signal?.throwIfAborted();
  const current = await read(signal);
  signal?.throwIfAborted();
  if (current.authenticated || !restore) return current;
  const result = await restore();
  signal?.throwIfAborted();
  if (result.status !== "restored") throw new Error("无法恢复本机会话，请重新连接或重启 OpenBot。");
  const renewed = await read(signal);
  signal?.throwIfAborted();
  if (!renewed.authenticated) throw new Error("本机会话验证未完成，请重新连接。");
  return renewed;
}
