import { timingSafeEqual } from "node:crypto";
import OpenAI, { toFile } from "openai";
import type postgres from "postgres";
import { boundedAttachmentText, parserResponseMaximum } from "./attachment-parser.js";
import type { ModelConnections, ResolvedConnection } from "./model-connections.js";
import { type ByteProviderTransport, directByteProviderTransport } from "./model-network.js";
import { type Attachment, attachmentMaximum, OwnerFiles } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import { WriteFailure } from "./primary-bot-write.js";
import { attachmentChannel } from "./product-attachments.js";
import type { AuthorizedProductOperation } from "./product-identity.js";

export class AttachmentTranscription {
  constructor(
    readonly models: ModelConnections,
    readonly files: OwnerFiles,
    readonly transport: ByteProviderTransport = directByteProviderTransport,
  ) {}
  private async selected(db: postgres.TransactionSql) {
    const [row] =
      await db`SELECT transcription_connection_id FROM owner_preferences WHERE owner_id='owner' FOR SHARE`;
    if (!row) return refuse(503, "owner_preferences_unavailable");
    if (row.transcription_connection_id === null)
      return refuse(415, "enabled_openai_transcription_required");
    const value = await this.models.resolve(db, {
      connectionId: row.transcription_connection_id,
      modelId: "whisper-1",
    });
    if (
      !value ||
      value.presetId !== "openai" ||
      value.baseUrl !== "https://api.openai.com/v1" ||
      !value.apiKey
    )
      return refuse(415, "enabled_openai_transcription_required");
    if (process.env.OPENAI_CUSTOM_HEADERS !== undefined || process.env.OPENAI_LOG !== undefined)
      return refuse(503, "ambient_transcription_configuration_refused");
    return value;
  }
  private async beforeSend(
    owner: AuthorizedProductOperation,
    channel: string | null,
    item: Attachment,
    selected: ResolvedConnection,
    signal: AbortSignal,
  ) {
    return this.files.withLock(
      (session) =>
        owner(async (db) => {
          await attachmentChannel(db, channel);
          const current = await this.selected(db);
          const a = Buffer.from(selected.apiKey),
            b = Buffer.from(current.apiKey);
          if (
            [
              "connectionId",
              "revision",
              "presetId",
              "protocol",
              "baseUrl",
              "modelId",
              "source",
            ].some(
              (key) =>
                current[key as keyof ResolvedConnection] !==
                selected[key as keyof ResolvedConnection],
            ) ||
            a.length !== b.length ||
            !timingSafeEqual(a, b)
          )
            return refuse(409, "model_connection_revision_conflict");
          const checked = session.content(channel, item.id).item;
          if (checked.deletedAt || checked.sha256 !== item.sha256)
            return refuse(404, "attachment_changed");
        }, session.signal),
      signal,
    );
  }
  async transcribe(
    owner: AuthorizedProductOperation,
    channel: string | null,
    item: Attachment,
    data: Buffer,
    signal: AbortSignal,
  ) {
    const selected = await owner((db) => this.selected(db), signal);
    await this.beforeSend(owner, channel, item, selected, signal);
    const deadline = AbortSignal.timeout(90000),
      bounded = AbortSignal.any([signal, deadline]);
    let sent = false,
      failure: unknown;
    const fetcher: typeof fetch = async (raw, init) => {
      try {
        const request = new Request(raw, init);
        if (
          sent ||
          request.url !== "https://api.openai.com/v1/audio/transcriptions" ||
          request.method !== "POST"
        )
          return refuse(415, "transcription_endpoint_refused");
        const contentType = request.headers.get("content-type");
        if (!contentType || !/^multipart\/form-data; boundary=[A-Za-z0-9_-]+$/.test(contentType))
          return refuse(415, "transcription_endpoint_refused");
        const bytes = Buffer.from(await request.arrayBuffer());
        if (bytes.length > attachmentMaximum + 16384) return refuse(413, "attachment_size_limit");
        await this.beforeSend(owner, channel, item, selected, bounded);
        bounded.throwIfAborted();
        sent = true;
        const response = await this.transport({
          url: request.url,
          method: "POST",
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "identity",
            Authorization: "Bearer " + selected.apiKey,
            "Content-Type": contentType,
            "Content-Length": String(bytes.length),
          },
          body: bytes,
          signal: bounded,
          maximum: parserResponseMaximum,
          responseKind: "transcription",
        });
        if (response.bytes.length > parserResponseMaximum)
          return refuse(413, "transcription_response_limit");
        if (response.status < 200 || response.status >= 300)
          return refuse(503, "transcription_provider_unavailable");
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(response.bytes),
          );
        } catch {
          return refuse(503, "transcription_provider_unavailable");
        }
        if (
          !value ||
          typeof value !== "object" ||
          !("text" in value) ||
          typeof value.text !== "string"
        )
          return refuse(503, "invalid_parser_response");
        return new Response(new Uint8Array(response.bytes), {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        failure = error;
        throw error;
      }
    };
    try {
      const sdk = new OpenAI({
        apiKey: selected.apiKey,
        baseURL: "https://api.openai.com/v1",
        organization: "",
        project: "",
        webhookSecret: "",
        maxRetries: 0,
        timeout: 90000,
        fetch: fetcher,
        logLevel: "off",
        defaultHeaders: {},
        defaultQuery: {},
      });
      const response = await sdk.audio.transcriptions.create(
        {
          model: "whisper-1",
          response_format: "json",
          file: await toFile(new Uint8Array(data), item.name, { type: item.mediaType }),
        },
        { signal: bounded },
      );
      bounded.throwIfAborted();
      return boundedAttachmentText(response.text);
    } catch (error) {
      if (signal.aborted) return refuse(400, "attachment_processing_cancelled");
      if (failure instanceof WriteFailure) throw failure;
      if (error instanceof WriteFailure) throw error;
      return refuse(503, "transcription_provider_unavailable");
    }
  }
}
