/** Creates Bot identities and initial membership under serialized workspace authority. */
import { LOCK_NAMESPACE } from "./database-locks.js";
import { randomUUID } from "node:crypto";
import { createBotInputSchema, quickCreateBotInputSchema } from "@openbot/protocol";
import type postgres from "postgres";
import { botProjection } from "./channel-read-projection.js";
import { primarySettings, publishPrimary } from "./identity-lifecycle.js";
import { type ModelConnections } from "./model-connections.js";
import { refuse } from "./owner-transaction.js";
import { direct, identityError, type ProductRoute } from "./product-identity.js";
import type { BotGreetings } from "./bot-greeting.js";

type DB = postgres.TransactionSql;
async function insert(
  db: DB,
  value: { name: string; role: string; computerProfile: string },
  configuration: postgres.JSONValue,
  quick = false,
) {
  const workspace = await primarySettings(db);
  const rows =
    await db`INSERT INTO bots(id,name,role,status,computer_profile,configuration,created_at,updated_at)
    VALUES(${randomUUID()},${value.name},${value.role},'idle',${value.computerProfile},${db.json(configuration)},date_trunc('milliseconds',statement_timestamp()),date_trunc('milliseconds',statement_timestamp()))
    ${quick ? db`ON CONFLICT(name) WHERE deleted_at IS NULL DO NOTHING` : db``} RETURNING *`;
  const row = rows[0];
  if (!row) return;
  await db`INSERT INTO employee_evolution_events(id,bot_id,type,title,summary,source,evidence,created_at) VALUES(${randomUUID()},${row.id},'created','Employee created',${value.name + " was created with the " + value.role + " role."},'manual','[]'::jsonb,${row.created_at})`;
  await db`INSERT INTO run_events(id,bot_id,type,payload) VALUES(${randomUUID()},${row.id},'BOT_CREATED',${db.json({ name: value.name, role: value.role })})`;
  if (workspace.primary_bot_id === null) await publishPrimary(db, workspace, row.id, "created");
  return botProjection(row);
}
export function creationRoutes(models: ModelConnections, greetings: BotGreetings): ProductRoute[] {
  const ordinary: ProductRoute = {
    method: "POST",
    path: "/api/v1/bots",
    kind: "typed",
    status: 201,
    error: "identity_storage_unavailable",
    execute: async (db, _ids, body) => {
      const parsed = createBotInputSchema.safeParse(body);
      if (!parsed.success) return refuse(422, "Invalid creation input.");
      const value = parsed.data,
        configuration: Record<string, postgres.JSONValue> = {};
      if (value.appearance) configuration.appearance = value.appearance;
      const selection =
        value.model ??
        (["model", "docker-linux"].includes(value.computerProfile)
          ? (await models.preferences(db)).defaultModel
          : null);
      if (selection) {
        await models.resolve(db, selection);
        configuration.model = selection;
      }
      return { bot: (await insert(db, value, configuration))! };
    },
  };
  const quick: ProductRoute = {
    method: "POST",
    path: "/api/v1/bots/quick",
    kind: "typed",
    status: 201,
    error: "identity_storage_unavailable",
    maxBytes: 8192,
    execute: async () => {
      throw new Error("Greeting follows committed quick creation.");
    },
    remote: async (owner, _ids, body) => {
      const result = await owner(async (db) => {
        try {
          const parsed = quickCreateBotInputSchema.safeParse(body);
          if (!parsed.success) return refuse(422, "Invalid creation input.");
          await db`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE.botCreation},12)`;
          const selection = (await models.preferences(db)).defaultModel,
            configuration: Record<string, postgres.JSONValue> = {
              appearance: parsed.data.appearance,
            };
          if (selection) {
            await models.resolve(db, selection);
            configuration.model = selection;
          }
          for (let n = 0; n < 3; n++) {
            const [candidate] =
              await db`SELECT candidate.name FROM generate_series(1,10001) AS suffix(n) CROSS JOIN LATERAL (SELECT CASE WHEN n=1 THEN '新建 Bot' ELSE '新建 Bot '||n::text END AS name) AS candidate WHERE NOT EXISTS(SELECT 1 FROM bots WHERE bots.name=candidate.name AND deleted_at IS NULL) ORDER BY n LIMIT 1`;
            if (!candidate) return refuse(409, "quick_bot_name_exhausted");
            const bot = await insert(
              db,
              { name: candidate.name, role: "通用助手", computerProfile: "none" },
              configuration,
              true,
            );
            if (bot) return { bot, ...(await direct(db, bot.id)) };
          }
          return refuse(409, "quick_bot_name_contention");
        } catch (error) {
          return identityError(error, quick);
        }
      });
      greetings.schedule(owner, result.bot.id, result.channel.id);
      return result;
    },
  };
  return [ordinary, quick];
}
