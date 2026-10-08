import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { WriteFailure, writeUnavailable } from "./primary-bot-write.js";

export const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const scalarText = (value: string) =>
  ![...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });
export function clientDigest(address: string | undefined): string {
  const value = address?.trim();
  const version = value && !value.includes("%") && isIP(value);
  if (!version) throw new WriteFailure(400, { error: "Client network identity is unavailable." });
  const canonical = version === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value!;
  return digest(`openbot:client-network:v1\0${canonical}`);
}

// A rejected request cannot free a slot still occupied by native work or a SQL transaction.
export function boundedAdmission(limit: number, waitForSettlement = false) {
  let active = 0;
  return async <T>(
    signal: AbortSignal,
    operation: (check: () => void) => Promise<T>,
  ): Promise<T> => {
    if (active >= limit || signal.aborted) throw writeUnavailable();
    active++;
    const deadline = new AbortController();
    const bounded = AbortSignal.any([signal, deadline.signal]);
    const check = () => {
      if (bounded.aborted) throw writeUnavailable();
    };
    let rejectAbort: (() => void) | undefined;
    const failure = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(writeUnavailable());
      bounded.addEventListener("abort", rejectAbort, { once: true });
    });
    const timer = setTimeout(() => deadline.abort(), 6000);
    timer.unref();
    const work = Promise.resolve()
      .then(() => {
        check();
        return operation(check);
      })
      .finally(() => {
        active--;
      });
    try {
      const result = await Promise.race([work, failure]);
      check();
      return result;
    } catch (error) {
      // File owners cannot release an inode lock or restore bytes while SQL can still commit.
      if (waitForSettlement) await work.catch(() => undefined);
      throw error instanceof WriteFailure ? error : writeUnavailable();
    } finally {
      clearTimeout(timer);
      if (rejectAbort) bounded.removeEventListener("abort", rejectAbort);
    }
  };
}

export function ownerCrypto() {
  const admit = boundedAdmission(2);
  const derive = (password: string, salt: Buffer, signal: AbortSignal) =>
    admit(
      signal,
      () =>
        new Promise<Buffer>((resolve, reject) => {
          if (!scalarText(password)) {
            reject(writeUnavailable());
            return;
          }
          scrypt(
            password,
            salt,
            32,
            { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
            (error, key) => (error ? reject(writeUnavailable()) : resolve(key)),
          );
        }),
    );
  return {
    async verify(
      password: string,
      stored: string | undefined,
      bootstrapDigest: string,
      signal: AbortSignal,
    ) {
      if (stored === undefined)
        return timingSafeEqual(
          Buffer.from(digest(password), "hex"),
          Buffer.from(bootstrapDigest, "hex"),
        );
      const match = /^scrypt\$32768\$8\$3\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(stored);
      if (!match) throw writeUnavailable();
      return timingSafeEqual(
        await derive(password, Buffer.from(match[1]!, "hex"), signal),
        Buffer.from(match[2]!, "hex"),
      );
    },
    async hash(password: string, signal: AbortSignal) {
      const salt = randomBytes(16);
      const key = await derive(password, salt, signal);
      return `scrypt$32768$8$3$${salt.toString("hex")}$${key.toString("hex")}`;
    },
  };
}
