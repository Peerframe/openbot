/** Reads transcription settings under Owner authority and preserves the existing session cookie wire format. */
import { ownerTransactions } from "./owner-transaction.js";
import { transcriptionSettingsSchema } from "@openbot/protocol";

import { HttpFailure } from "./http-errors.js";
// Retain Starlette's last named cookie and CPython quoted-cookie wire behavior. This
// is an independent compatibility implementation; URL percent decoding is not cookie parsing.
export function ownerCookie(
  header: string | undefined,
  secure: boolean,
  strict = true,
): string | undefined {
  const name = secure ? "__Host-openbot_session" : "openbot_session";
  let value: string | undefined;
  for (const chunk of (header ?? "").split(";")) {
    const separator = chunk.indexOf("=");
    if (separator < 0 || chunk.slice(0, separator).trim() !== name) continue;
    value = chunk.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\([0-3][0-7]{2}|[\s\S])/g, (_match, escaped: string) =>
          /^[0-3][0-7]{2}$/.test(escaped) ? String.fromCharCode(parseInt(escaped, 8)) : escaped,
        );
    }
  }
  return value !== undefined && (!strict || /^[A-Za-z0-9_-]{43}$/.test(value)) ? value : undefined;
}

export function transcriptionReader(databaseUrl: string) {
  const store = ownerTransactions(databaseUrl, 4);
  return {
    verify: () => store.verify(async (db) => {
      await db`SELECT revision,transcription_connection_id FROM owner_preferences WHERE false`;
    }),
    close: store.close,
    read: (token: string | undefined, signal: AbortSignal) =>
      store.run(token, signal, async (db) => {
        const rows = await db`SELECT revision,transcription_connection_id AS "connectionId"
          FROM owner_preferences WHERE owner_id='owner' FOR SHARE`;
        if (rows.length !== 1)
          throw new HttpFailure(503, { error: "owner_preferences_unavailable" });
        return transcriptionSettingsSchema.parse(rows[0]);
      }),
  };
}
