/** Implements attachment parser behavior for the Server. */
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { attachmentMaximum } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import { HttpFailure } from "./http-errors.js";

export type ProcessCommand = {
  operation: "extract" | "ocr" | "transcribe";
  password?: string | undefined;
};
export type ParsedAttachment = { text: string; truncated: boolean };
export const textMaximum = 262144;
export const parserResponseMaximum = 2 * 1024 * 1024;
export function parsedAttachment(value: unknown): ParsedAttachment {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "text,truncated" ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    value.text.length > textMaximum ||
    !("truncated" in value) ||
    typeof value.truncated !== "boolean"
  )
    return refuse(503, "invalid_parser_response");
  return value as ParsedAttachment;
}
export function boundedAttachmentText(value: unknown): ParsedAttachment {
  if (typeof value !== "string") return refuse(503, "invalid_parser_response");
  const source = value.slice(0, textMaximum);
  let text = "";
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        text += source.slice(i, i + 2);
        i++;
      }
    } else if (code < 0xdc00 || code > 0xdfff) text += source[i];
  }
  return { text, truncated: value.length > textMaximum };
}
export function boundedImage(data: Buffer, media: string) {
  let width = 0,
    height = 0;
  if (media === "image/png" && data.length >= 24) {
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
  } else {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 255) break;
      if ([192, 193, 194].includes(data[offset + 1]!)) {
        height = data.readUInt16BE(offset + 5);
        width = data.readUInt16BE(offset + 7);
        break;
      }
      const length = data.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += length + 2;
    }
  }
  if (!width || !height || width * height > 16000000 || width > 16000 || height > 16000)
    return refuse(413, "ocr_image_dimensions_exceeded");
}
export class NodeAttachmentParser {
  readonly worker: string;
  readonly modules: string;
  constructor(
    worker: string,
    modules: string,
    readonly timeoutMs?: number,
  ) {
    if (
      !isAbsolute(worker) ||
      !isAbsolute(modules) ||
      (timeoutMs !== undefined &&
        (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000))
    )
      throw new Error("Invalid fixed parser configuration.");
    this.worker = realpathSync(worker);
    this.modules = realpathSync(modules);
    if (!statSync(this.worker).isFile() || !statSync(this.modules).isDirectory())
      throw new Error("Parser files unavailable.");
  }
  async parse(
    data: Buffer,
    extension: string,
    command: ProcessCommand,
    signal: AbortSignal,
  ): Promise<ParsedAttachment> {
    if (!data.length || data.length > attachmentMaximum)
      return refuse(413, "attachment_size_limit");
    if (signal.aborted) return refuse(400, "attachment_processing_cancelled");
    if (command.operation !== "extract" && command.operation !== "ocr")
      return refuse(400, "invalid_parser_operation");
    if (
      !(
        command.operation === "ocr"
          ? ["png", "jpg", "jpeg"]
          : ["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp"]
      ).includes(extension)
    )
      return refuse(415, "attachment_parser_format_refused");
    const directory = await mkdtemp(join(realpathSync(tmpdir()), "openbot-parser-"));
    try {
      const output = await new Promise<Buffer>((resolve, reject) => {
        // Same reviewed helper and Node permission envelope as Python; no shell or inherited keys.
        const child = spawn(
          process.execPath,
          [
            "--permission",
            "--allow-worker",
            "--allow-addons",
            "--allow-fs-read=" + this.modules,
            "--allow-fs-read=" + this.worker,
            "--allow-fs-read=" + directory,
            "--allow-fs-write=" + directory,
            "--max-old-space-size=256",
            "--max-semi-space-size=32",
            "--stack-size=4096",
            "--import",
            this.worker,
            this.worker,
            this.modules,
            directory,
          ],
          {
            cwd: directory,
            env: { LANG: "C.UTF-8" },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const chunks: Buffer[] = [];
        let size = 0,
          errors = 0,
          closed = false,
          failure: HttpFailure | undefined;
        const stop = (error: HttpFailure) => {
          failure ??= error;
          if (child.pid && !closed)
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
                failure = new HttpFailure(503, { error: "attachment_parser_unavailable" });
            }
        };
        const aborted = () =>
          stop(new HttpFailure(400, { error: "attachment_processing_cancelled" }));
        const timer = setTimeout(
          () => stop(new HttpFailure(413, { error: "attachment_processing_timed_out" })),
          Math.min(this.timeoutMs ?? 60000, command.operation === "ocr" ? 60000 : 30000),
        );
        timer.unref();
        child.once("error", () =>
          stop(new HttpFailure(503, { error: "attachment_parser_unavailable" })),
        );
        child.stdin.on("error", () =>
          stop(new HttpFailure(503, { error: "attachment_parser_unavailable" })),
        );
        child.stdout.on("error", () =>
          stop(new HttpFailure(503, { error: "attachment_parser_unavailable" })),
        );
        child.stderr.on("error", () =>
          stop(new HttpFailure(503, { error: "attachment_parser_unavailable" })),
        );
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > parserResponseMaximum)
            stop(new HttpFailure(413, { error: "parser_output_limit" }));
          else chunks.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          errors += chunk.length;
          if (errors > 65536) stop(new HttpFailure(413, { error: "parser_output_limit" }));
        });
        child.once("close", (code) => {
          closed = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", aborted);
          if (failure) reject(failure);
          else if (code !== 0)
            reject(new HttpFailure(413, { error: "attachment_parser_stopped" }));
          else resolve(Buffer.concat(chunks));
        });
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
        const header = Buffer.from(
          JSON.stringify({
            operation: command.operation,
            extension,
            size: data.length,
            ...(command.password !== undefined ? { password: command.password } : {}),
          }) + "\n",
        );
        child.stdin.end(Buffer.concat([header, data]));
      });
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
      } catch {
        return refuse(503, "attachment_parser_unavailable");
      }
      if (
        value &&
        typeof value === "object" &&
        Object.keys(value).join() === "error" &&
        "error" in value
      ) {
        const code = [
          "pdf_password_required",
          "parser_dependency_unavailable",
          "attachment_parsing_failed",
        ].includes(String(value.error))
          ? String(value.error)
          : "attachment_parsing_failed";
        return refuse(code === "parser_dependency_unavailable" ? 503 : 400, code);
      }
      return parsedAttachment(value);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
