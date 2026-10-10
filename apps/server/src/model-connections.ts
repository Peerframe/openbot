/** Implements model connections behavior for the Server. */
import { LOCK_NAMESPACE } from "./database-locks.js";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { modelProviderPresets } from "@openbot/domain";
import {
  createModelConnectionInputSchema,
  deleteModelConnectionInputSchema,
  employeeProfileMutationSchema,
  type ModelSelection,
  modelBaseUrlSchema,
  modelConnectionSchema,
  modelIdSchema,
  modelSelectionSchema,
  ownerPreferencesInputSchema,
  ownerPreferencesSchema,
  transcriptionSettingsInputSchema,
  updateEmployeeModelInputSchema,
  updateModelConnectionInputSchema,
} from "@openbot/protocol";
import type postgres from "postgres";
import type { z } from "zod";
import { botProjection } from "./channel-read-projection.js";
import { ModelCredentialCipher } from "./model-credential-cipher.js";
import { refuse } from "./owner-transaction.js";
import { HttpFailure } from "./http-errors.js";
import type { ProductRoute } from "./product-identity.js";

type DB = postgres.TransactionSql;
type Row = postgres.Row;
export const modelPresets = () => [
  ...structuredClone(modelProviderPresets).map((p) => ({
    ...p,
    id: p.id === "moonshot" ? "kimi" : p.id,
  })),
  {
    id: "custom",
    name: "Custom OpenAI-compatible API / 自定义兼容 API",
    protocol: "openai-chat" as const,
    endpoints: [],
    suggestedModels: [],
    discovery: true,
    description: "Use an exact HTTPS endpoint authorized by the Server operator.",
    docsUrl: "https://developers.openai.com/api/reference/resources/chat/subresources/completions",
  },
];
export class ConnectionPolicy {
  readonly customBaseUrls: readonly string[];
  constructor(urls: readonly string[] = []) {
    if (!Array.isArray(urls) || urls.length > 128)
      throw new Error("Invalid model endpoint configuration.");
    this.customBaseUrls = Object.freeze([
      ...new Set(urls.map((url) => modelBaseUrlSchema.parse(url).replace(/\/+$/, ""))),
    ]);
  }
  preset(id: string) {
    const value = modelPresets().find((p) => p.id === id);
    if (!value) throw new Error("Unknown model preset.");
    return value;
  }
  endpoint(presetId: string, raw: string, protocol?: string) {
    try {
      const preset = this.preset(presetId);
      if (protocol !== undefined && protocol !== preset.protocol) throw new Error();
      const value = modelBaseUrlSchema.parse(raw).replace(/\/+$/, "");
      const urls =
        presetId === "custom"
          ? this.customBaseUrls
          : preset.endpoints.map((e) => e.baseUrl.replace(/\/+$/, ""));
      if (!urls.includes(value)) throw new Error();
      return value;
    } catch {
      return refuse(422, "model_endpoint_not_authorized");
    }
  }
}
export const modelInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (
    !parsed.success ||
    (typeof parsed.data === "object" &&
      parsed.data !== null &&
      "expectedRevision" in parsed.data &&
      Number(parsed.data.expectedRevision) > 2147483647)
  )
    return refuse(422, "Invalid request input.");
  return parsed.data;
};
const date = (value: Date) => value.toISOString();
const publicConnection = (row: Row) =>
  modelConnectionSchema.parse({
    id: row.id,
    name: row.name,
    presetId: row.preset_id,
    baseUrl: row.base_url,
    protocol: row.protocol,
    enabled: row.enabled,
    hasApiKey: Boolean(row.encrypted_api_key),
    revision: row.revision,
    source: "saved",
    ...(row.default_model === null ? {} : { defaultModel: modelIdSchema.parse(row.default_model) }),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  });
const context = (row: Row) => ({
  id: row.id as string,
  presetId: row.preset_id as string,
  baseUrl: row.base_url as string,
});
const selection = (value: unknown, dependency = false): ModelSelection | null => {
  if (value === null && !dependency) return null;
  const parsed = modelSelectionSchema.safeParse(value);
  if (!parsed.success)
    return refuse(
      dependency ? 503 : 422,
      dependency ? "model_dependencies_unavailable" : "stored_model_selection_invalid",
    );
  return parsed.data;
};
const sameSelection = (a: ModelSelection | null, b: ModelSelection | null) =>
  a?.connectionId === b?.connectionId && a?.modelId === b?.modelId;
async function audit(
  db: DB,
  type: string,
  payload: postgres.JSONValue,
  botId: string | null = null,
) {
  await db`INSERT INTO run_events(id,bot_id,type,payload) VALUES(${randomUUID()},${botId},${type},${db.json(payload)})`;
}
// Python ZoneInfo resolves these same POSIX roots. Verify exact case (macOS filesystems may not)
// and an actual TZif file, including aliases omitted by Intl.supportedValuesOf('timeZone').
function timezone(value: string): string {
  for (const root of [
    "/usr/share/zoneinfo",
    "/usr/lib/zoneinfo",
    "/usr/share/lib/zoneinfo",
    "/etc/zoneinfo",
  ]) {
    let path = root,
      fd: number | undefined;
    try {
      for (const name of value.split("/")) {
        if (!readdirSync(path).includes(name)) throw new Error();
        path = join(path, name);
      }
      fd = openSync(path, "r");
      const header = Buffer.alloc(44);
      if (readSync(fd, header, 0, 44, 0) === 44 && header.subarray(0, 4).toString() === "TZif")
        return value;
    } catch {
      /* Try the next standard ZoneInfo root; never accept an environment path. */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return refuse(422, "Invalid request input.");
}
export type ResolvedConnection = {
  connectionId: string;
  revision: number;
  presetId: string;
  protocol: "openai-chat" | "anthropic-messages";
  baseUrl: string;
  modelId: string;
  apiKey: string;
  source: "saved";
};
export class ModelConnections {
  readonly policy: ConnectionPolicy;
  #cipher: ModelCredentialCipher | undefined;
  constructor(
    readonly keyPath: string,
    urls: readonly string[] = [],
  ) {
    this.policy = new ConnectionPolicy(urls);
  }
  async initialize(db: DB) {
    await db`SELECT id,name,preset_id,base_url,protocol,encrypted_api_key,enabled,revision,default_model,created_at,updated_at FROM model_connections LIMIT 0`;
    await db`SELECT model_selection FROM runs LIMIT 0`;
    const [row] = await db`SELECT EXISTS(SELECT 1 FROM model_connections) AS present`;
    this.#cipher = await ModelCredentialCipher.load(this.keyPath, !row!.present);
  }
  private cipher() {
    if (!this.#cipher) return refuse(503, "model_credential_unavailable");
    return this.#cipher;
  }
  async snapshot(db: DB) {
    const rows = await db`SELECT * FROM model_connections ORDER BY created_at,id LIMIT 33`;
    if (rows.length > 32) refuse(503, "model_connection_limit");
    return {
      presets: modelPresets(),
      connections: rows.map(publicConnection),
      customBaseUrls: this.policy.customBaseUrls,
    };
  }
  async create(db: DB, body: unknown) {
    const value = modelInput(createModelConnectionInputSchema, body);
    const baseUrl = this.policy.endpoint(value.presetId, value.baseUrl);
    const id = randomUUID(),
      protocol = this.policy.preset(value.presetId).protocol;
    const encrypted = this.cipher().encrypt(value.apiKey, {
      id,
      presetId: value.presetId,
      baseUrl,
    });
    await db`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE.modelConnections},1)`;
    const [count] = await db`SELECT count(*)::integer AS total FROM model_connections`;
    if (count!.total >= 32) refuse(422, "model_connection_limit");
    const [row] =
      await db`INSERT INTO model_connections(id,name,preset_id,base_url,protocol,encrypted_api_key,default_model)
      VALUES(${id},${value.name},${value.presetId},${baseUrl},${protocol},${encrypted},${value.defaultModel ?? null}) RETURNING *`;
    await audit(db, "MODEL_CONNECTION_CREATED", {
      id,
      presetId: value.presetId,
      revision: row!.revision,
    });
    return { connection: publicConnection(row!) };
  }
  async update(db: DB, id: string, body: unknown) {
    const value = modelInput(updateModelConnectionInputSchema, body);
    if (id === "legacy-kimi") refuse(422, "environment_model_connection_read_only");
    const [old] = await db`SELECT * FROM model_connections WHERE id=${id} FOR UPDATE`;
    if (!old) return refuse(404, "model_connection_not_found");
    if (old.revision !== value.expectedRevision) refuse(409, "model_connection_revision_conflict");
    const name = value.name ?? old.name,
      enabled = value.enabled ?? old.enabled;
    const defaultModel = value.defaultModel === undefined ? old.default_model : value.defaultModel;
    const changed = [
      ...(name !== old.name ? ["name"] : []),
      ...(value.apiKey !== undefined ? ["apiKey"] : []),
      ...(enabled !== old.enabled ? ["enabled"] : []),
      ...(defaultModel !== old.default_model ? ["defaultModel"] : []),
    ];
    if (!changed.length) return { connection: publicConnection(old) };
    if (old.revision === 2147483647) refuse(409, "model_connection_revision_exhausted");
    const encrypted =
      value.apiKey === undefined
        ? old.encrypted_api_key
        : this.cipher().encrypt(value.apiKey, context(old));
    const [row] =
      await db`UPDATE model_connections SET name=${name},enabled=${enabled},encrypted_api_key=${encrypted},default_model=${defaultModel},revision=revision+1,updated_at=clock_timestamp() WHERE id=${id} AND revision=${value.expectedRevision} RETURNING *`;
    if (!row) return refuse(409, "model_connection_revision_conflict");
    await audit(db, "MODEL_CONNECTION_UPDATED", {
      id,
      presetId: row.preset_id,
      changedFields: changed,
      revision: row.revision,
    });
    return { connection: publicConnection(row) };
  }
  async delete(db: DB, id: string, body: unknown) {
    const value = modelInput(deleteModelConnectionInputSchema, body);
    if (id === "legacy-kimi") refuse(422, "environment_model_connection_read_only");
    const [row] = await db`SELECT * FROM model_connections WHERE id=${id} FOR UPDATE`;
    if (!row) return refuse(404, "model_connection_not_found");
    if (row.revision !== value.expectedRevision) refuse(409, "model_connection_revision_conflict");
    // Readers only here: Bot writers acquire Bot then connection SHARE, so reverse locking deadlocks.
    const bots =
      await db`SELECT id,name,CASE WHEN octet_length((configuration->'model')::text)<=1024 THEN configuration->'model' END AS model FROM bots WHERE deleted_at IS NULL AND configuration->'model' IS NOT NULL AND configuration->'model'<>'null'::jsonb ORDER BY id COLLATE "C" LIMIT 1001`;
    const runs =
      await db`SELECT id,CASE WHEN octet_length(model_selection::text)<=1024 THEN model_selection END AS model_selection FROM runs_work_projection WHERE status IN ('queued','assigned','running','waiting_approval','blocked') AND model_selection IS NOT NULL ORDER BY id COLLATE "C" LIMIT 1001`;
    if (Math.max(bots.length, runs.length) > 1000) refuse(503, "model_dependency_limit");
    const dependents = bots
      .filter((b) => selection(b.model, true)!.connectionId === id)
      .map((b) => ({ id: b.id, name: b.name }));
    const runIds = runs
      .filter((r) => selection(r.model_selection, true)!.connectionId === id)
      .map((r) => r.id);
    const [preferences] =
      await db`SELECT default_model,transcription_connection_id FROM owner_preferences WHERE owner_id='owner'`;
    if (!preferences) return refuse(503, "owner_preferences_unavailable");
    const ownerDefault = selection(preferences.default_model)?.connectionId === id;
    const transcription = preferences.transcription_connection_id === id;
    if (dependents.length || runIds.length || ownerDefault || transcription) {
      const conflict = {
        error: "model_connection_in_use",
        bots: dependents,
        runIds,
        ownerDefault,
        transcription,
      };
      throw new HttpFailure(409, conflict);
    }
    await db`DELETE FROM model_connections WHERE id=${id}`;
    await audit(db, "MODEL_CONNECTION_DELETED", { id, revision: row.revision });
    return { deleted: true, connectionId: id };
  }
  async resolve(
    db: DB,
    input: unknown,
    expectedRevision?: number,
  ): Promise<ResolvedConnection | null> {
    const value = selection(input);
    if (value === null) return null; // Product startup has no ambient environment fallback.
    const [row] =
      await db`SELECT * FROM model_connections WHERE id=${value.connectionId} FOR SHARE`;
    if (!row) return refuse(404, "model_connection_not_found");
    if (!row.enabled) refuse(422, "model_connection_disabled");
    const baseUrl = this.policy.endpoint(row.preset_id, row.base_url, row.protocol);
    const apiKey = this.cipher().decrypt(row.encrypted_api_key, context(row));
    if (expectedRevision !== undefined && expectedRevision !== row.revision)
      refuse(409, "model_connection_revision_conflict");
    return {
      connectionId: row.id,
      revision: row.revision,
      presetId: row.preset_id,
      protocol: row.protocol,
      baseUrl,
      modelId: value.modelId,
      apiKey,
      source: "saved",
    };
  }
  async employee(db: DB, id: string, body: unknown) {
    const value = modelInput(updateEmployeeModelInputSchema, body);
    const [before] = await db`SELECT * FROM bots WHERE id=${id} AND deleted_at IS NULL FOR UPDATE`;
    if (!before) return refuse(404, "bot_not_found");
    if (!["model", "docker-linux"].includes(before.computer_profile))
      refuse(422, "employee_model_profile_required");
    if (before.profile_revision !== value.expectedRevision)
      refuse(409, "employee_profile_revision_conflict");
    const configuration =
      before.configuration &&
      typeof before.configuration === "object" &&
      !Array.isArray(before.configuration)
        ? { ...before.configuration }
        : {};
    if (sameSelection(selection(configuration.model ?? null), value.model))
      refuse(422, "employee_model_unchanged");
    if (value.model) {
      await this.resolve(db, value.model);
      configuration.model = value.model;
    } else delete configuration.model;
    const [row] =
      await db`UPDATE bots SET configuration=${db.json(configuration)},profile_revision=profile_revision+1,updated_at=clock_timestamp() WHERE id=${id} AND profile_revision=${value.expectedRevision} RETURNING *`;
    if (!row) return refuse(409, "employee_profile_revision_conflict");
    const [event] =
      await db`INSERT INTO employee_evolution_events(id,bot_id,type,title,summary,source,evidence) VALUES(${randomUUID()},${id},'configuration_changed','Employee model updated','Owner updated the model connection and model selection.','manual','[]') RETURNING *`;
    await audit(
      db,
      "EMPLOYEE_MODEL_UPDATED",
      { changedFields: ["model"], revision: row.profile_revision },
      id,
    );
    return employeeProfileMutationSchema.parse({
      employee: botProjection(row),
      details: {
        description: row.description,
        revision: row.profile_revision,
        updatedAt: date(row.updated_at),
      },
      evolution: {
        id: event!.id,
        botId: id,
        type: "configuration_changed",
        title: event!.title,
        summary: event!.summary,
        source: "manual",
        evidence: [],
        createdAt: date(event!.created_at),
      },
    });
  }
  async preferences(db: DB, update = false) {
    const [row] = await db.unsafe(
      "SELECT * FROM owner_preferences WHERE owner_id='owner' " +
        (update ? "FOR UPDATE" : "FOR SHARE"),
    );
    if (!row) return refuse(503, "owner_preferences_unavailable");
    try {
      const result = ownerPreferencesSchema.parse({
        revision: row.revision,
        timezone: row.timezone,
        defaultModel: row.default_model,
        updatedAt: date(row.updated_at),
      });
      timezone(result.timezone);
      return result;
    } catch {
      return refuse(503, "owner_preferences_unavailable");
    }
  }
  async savePreferences(db: DB, body: unknown) {
    const value = modelInput(ownerPreferencesInputSchema, body);
    timezone(value.timezone);
    const before = await this.preferences(db, true);
    if (value.expectedRevision !== before.revision)
      refuse(409, "owner_preferences_revision_conflict");
    if (value.defaultModel) await this.resolve(db, value.defaultModel);
    const changed = [
      ...(before.timezone !== value.timezone ? ["timezone"] : []),
      ...(!sameSelection(before.defaultModel, value.defaultModel) ? ["defaultModel"] : []),
    ];
    if (!changed.length) return before;
    if (before.revision === 2147483647) refuse(409, "owner_preferences_revision_exhausted");
    const [row] =
      await db`UPDATE owner_preferences SET timezone=${value.timezone},default_model=${value.defaultModel === null ? null : db.json(value.defaultModel)},revision=revision+1,updated_at=clock_timestamp() WHERE owner_id='owner' RETURNING revision`;
    await audit(db, "SETTINGS_OWNER_UPDATED", { actor: "owner", changed, revision: row!.revision });
    return this.preferences(db);
  }
  async saveTranscription(db: DB, body: unknown) {
    const value = modelInput(transcriptionSettingsInputSchema, body);
    const [before] =
      await db`SELECT revision,transcription_connection_id FROM owner_preferences WHERE owner_id='owner' FOR UPDATE`;
    if (!before) return refuse(503, "owner_preferences_unavailable");
    if (value.expectedRevision !== before.revision)
      refuse(409, "owner_preferences_revision_conflict");
    if (value.connectionId !== null) {
      const selected = await this.resolve(db, {
        connectionId: value.connectionId,
        modelId: "whisper-1",
      });
      if (
        selected?.presetId !== "openai" ||
        selected.source !== "saved" ||
        selected.baseUrl !== "https://api.openai.com/v1"
      )
        refuse(415, "enabled_openai_transcription_required");
    }
    if (value.connectionId === before.transcription_connection_id)
      return { revision: before.revision, connectionId: value.connectionId };
    if (before.revision === 2147483647) refuse(409, "owner_preferences_revision_exhausted");
    const [row] =
      await db`UPDATE owner_preferences SET transcription_connection_id=${value.connectionId},revision=revision+1,updated_at=clock_timestamp() WHERE owner_id='owner' RETURNING revision`;
    await audit(db, "SETTINGS_OWNER_UPDATED", {
      actor: "owner",
      changed: ["transcriptionConnection"],
      revision: row!.revision,
    });
    return { revision: row!.revision, connectionId: value.connectionId };
  }
}
export function modelRoutes(models: ModelConnections): ProductRoute[] {
  const route = (
    method: string,
    path: string,
    maxBytes: number,
    execute: ProductRoute["execute"],
    status = 200,
  ): ProductRoute => ({
    method,
    path,
    maxBytes,
    execute,
    status,
    kind: "product",
    error: "model_connections_storage_unavailable",
  });
  return [
    route("GET", "/api/v1/model-services", 0, (db) => models.snapshot(db)),
    route(
      "POST",
      "/api/v1/model-connections",
      8192,
      (db, _ids, body) => models.create(db, body),
      201,
    ),
    route("PATCH", "/api/v1/model-connections/{connection_id}", 4096, (db, ids, body) =>
      models.update(db, ids[0]!, body),
    ),
    route("DELETE", "/api/v1/model-connections/{connection_id}", 1024, (db, ids, body) =>
      models.delete(db, ids[0]!, body),
    ),
    route("PATCH", "/api/v1/bots/{bot_id}/model", 2048, (db, ids, body) =>
      models.employee(db, ids[0]!, body),
    ),
    route("GET", "/api/v1/settings/general", 0, (db) => models.preferences(db)),
    route("PUT", "/api/v1/settings/general", 2048, (db, _ids, body) =>
      models.savePreferences(db, body),
    ),
    route("PUT", "/api/v1/settings/transcription", 1024, (db, _ids, body) =>
      models.saveTranscription(db, body),
    ),
  ];
}
