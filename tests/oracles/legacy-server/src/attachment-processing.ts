import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { modelProviderBaseUrl } from "@openbot/domain";
import type { AttachmentOperation } from "@openbot/protocol";
import {
  AttachmentError,
  type ChannelAttachmentStorage,
  type DerivedAttachmentText,
} from "./channel-attachments.js";
import type { AgentModelSettings } from "./model-settings.js";

export type AttachmentProcessInput = {
  operation: AttachmentOperation;
  password?: string | undefined;
};
const MAX_TEXT = 262144;
// This fixed program handles only transferred bytes. No parser path, URL or executable comes from a file.
const PARSER_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
 const { bytes, extension, password, operation, modules, languageDirectory } = workerData;
 let text = ''; let truncated = false;
 if (operation === 'ocr') {
   const { createWorker } = await import(modules.tesseract);
   const worker = await createWorker('eng+chi_sim', 1, { langPath: languageDirectory, gzip: true, cacheMethod: 'none', logger: () => {} });
   try { const result = await worker.recognize(Buffer.from(bytes)); text = result.data.text; }
   finally { await worker.terminate(); }
 } else if (extension === 'pdf') {
   const { getDocument } = await import(modules.pdf);
   const task = getDocument({ data: Uint8Array.from(bytes), password, standardFontDataUrl: modules.fonts, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, disableAutoFetch: true, stopAtErrors: true });
   try {
     const pdf = await task.promise;
     const pages = Math.min(pdf.numPages, 200);
     truncated = pages < pdf.numPages;
     for (let page = 1; page <= pages; page++) {
       const content = await (await pdf.getPage(page)).getTextContent();
       for (const item of content.items) { if (typeof item.str === 'string') text += item.str + (item.hasEOL ? '\n' : ' '); }
       text += '\n';
       if (text.length > 262144) { truncated = true; break; }
     }
   } finally { await task.destroy(); }
 } else {
   const { OfficeParser } = await import(modules.office);
   const ast = await OfficeParser.parseOffice(Buffer.from(bytes), { fileType: extension, ocr: false, extractAttachments: false, decompressionLimits: { maxUncompressedBytes: 33554432, maxZipEntries: 2000, maxTableCells: 100000 } });
   text = ast.toText();
 }
 truncated ||= text.length > 262144;
 parentPort.postMessage({ text: text.slice(0, 262144), truncated });
})().catch(error => parentPort.postMessage({ error: error?.name === 'PasswordException' ? 'PDF password is missing or incorrect.' : 'Attachment parsing failed or exceeded its limits.' }));
`;

export class AttachmentProcessingService {
  #active = 0;
  constructor(
    readonly options: {
      storage: ChannelAttachmentStorage;
      settings?: () => Promise<AgentModelSettings | undefined>;
      fetcher?: typeof fetch;
    },
  ) {}

  async process(
    channelId: string,
    id: string,
    input: AttachmentProcessInput,
    signal?: AbortSignal,
  ) {
    if (this.#active >= 2)
      throw new AttachmentError("Two attachment jobs are already running.", 503);
    if (!this.options.storage.saveDerived)
      throw new AttachmentError("Derived storage unavailable.", 503);
    this.#active += 1;
    try {
      const { attachment, bytes } = await this.options.storage.read(channelId, id);
      if (attachment.deletedAt)
        throw new AttachmentError("Restore this attachment before processing.", 400);
      const extension = attachment.name.split(".").at(-1)?.toLowerCase() ?? "";
      if (input.password && extension !== "pdf")
        throw new AttachmentError("Passwords are supported only for PDF.");
      let result: { text: string; truncated: boolean };
      if (input.operation === "transcribe") {
        if (
          !attachment.mediaType.startsWith("audio/") &&
          !attachment.mediaType.startsWith("video/")
        )
          throw new AttachmentError("Choose an audio or video attachment.", 415);
        result = await this.#transcribe(bytes, attachment.name, attachment.mediaType, signal);
      } else {
        if (input.operation === "ocr") {
          if (!["image/png", "image/jpeg"].includes(attachment.mediaType))
            throw new AttachmentError("OCR accepts PNG or JPEG images.", 415);
          assertBoundedImage(bytes, attachment.mediaType);
        } else if (!["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp"].includes(extension))
          throw new AttachmentError("This document does not need extraction.", 415);
        result = await parseInWorker(bytes, extension, input, signal);
      }
      if (signal?.aborted) throw new AttachmentError("Attachment processing cancelled.");
      if (!result.text.trim())
        throw new AttachmentError(
          extension === "pdf"
            ? "No readable PDF text was found. The PDF may be scanned or blank. Upload PNG/JPEG pages and choose image OCR, or use a PDF with a text layer."
            : "No readable text was found. Check the original attachment and retry with readable content.",
          415,
        );
      const derived: DerivedAttachmentText = {
        ...result,
        sha256: attachment.sha256,
        operation: input.operation,
        processedAt: new Date().toISOString(),
      };
      return await this.options.storage.saveDerived(channelId, id, derived);
    } finally {
      this.#active -= 1;
    }
  }
  async #transcribe(bytes: Buffer, name: string, mediaType: string, signal?: AbortSignal) {
    const settings = await this.options.settings?.();
    if (settings?.provider !== "openai")
      throw new AttachmentError(
        "Transcription requires an enabled OpenAI connection. This action sends the selected media to OpenAI.",
        415,
      );
    const endpoint = new URL(
      "audio/transcriptions",
      `${modelProviderBaseUrl(settings.provider, settings.baseUrl).replace(/\/$/u, "")}/`,
    );
    if (endpoint.origin !== "https://api.openai.com")
      throw new AttachmentError("Transcription endpoint is not supported.", 415);
    const form = new FormData();
    form.set("model", "whisper-1");
    form.set("response_format", "json");
    form.set("file", new Blob([Uint8Array.from(bytes)], { type: mediaType }), name);
    const response = await (this.options.fetcher ?? fetch)(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body: form,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
        : AbortSignal.timeout(90000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AttachmentError("The configured provider could not transcribe this media.", 503);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AttachmentError("Empty transcription response.", 503);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 2 * 1024 * 1024)
          throw new AttachmentError("Transcription response exceeds limit.", 413);
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: unknown };
    if (typeof result.text !== "string")
      throw new AttachmentError("Invalid transcription response.", 503);
    return { text: result.text.slice(0, MAX_TEXT), truncated: result.text.length > MAX_TEXT };
  }
}

export async function parseInWorker(
  bytes: Buffer,
  extension: string,
  input: AttachmentProcessInput,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  if (signal?.aborted) throw new AttachmentError("Attachment processing cancelled.");
  const languageDirectory = input.operation === "ocr" ? await offlineOcrLanguages() : undefined;
  try {
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AttachmentError("Attachment processing cancelled."));
        return;
      }
      const worker = new Worker(PARSER_WORKER, {
        eval: true,
        resourceLimits: {
          maxOldGenerationSizeMb: 256,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
        workerData: {
          bytes,
          extension,
          operation: input.operation,
          password: input.password,
          languageDirectory,
          modules: {
            office: import.meta.resolve("officeparser"),
            pdf: import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"),
            // PDF.js requires a trailing forward slash even for Node filesystem paths.
            fonts: fileURLToPath(
              new URL(
                "../../standard_fonts/",
                import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"),
              ),
            ).replaceAll("\\", "/"),
            tesseract: import.meta.resolve("tesseract.js"),
          },
        },
      });
      let settled = false;
      const finish = (error?: Error, value?: { text: string; truncated: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        void worker.terminate().then(
          () => {
            if (error) reject(error);
            else if (value) resolve(value);
          },
          () => reject(new AttachmentError("Parser shutdown failed.", 503)),
        );
      };
      const abort = () => finish(new AttachmentError("Attachment processing cancelled."));
      const timer = setTimeout(
        () => finish(new AttachmentError("Attachment processing timed out.", 413)),
        input.operation === "ocr" ? 60000 : 30000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("error", () =>
        finish(new AttachmentError("Attachment parser exceeded resources or failed.", 413)),
      );
      worker.once("exit", (code) => {
        if (code !== 0) finish(new AttachmentError("Attachment parser stopped.", 413));
      });
      worker.once("message", (value: { text?: unknown; truncated?: unknown; error?: unknown }) => {
        if (typeof value.error === "string") finish(new AttachmentError(value.error));
        else if (
          typeof value.text !== "string" ||
          value.text.length > MAX_TEXT ||
          typeof value.truncated !== "boolean"
        )
          finish(new AttachmentError("Invalid parser response.", 503));
        else finish(undefined, { text: value.text, truncated: value.truncated });
      });
    });
  } finally {
    if (languageDirectory) {
      const { rm } = await import("node:fs/promises");
      await rm(languageDirectory, { recursive: true, force: true });
    }
  }
}
async function offlineOcrLanguages(): Promise<string> {
  const { cp, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), "openbot-ocr-languages-"));
  try {
    for (const code of ["eng", "chi_sim"]) {
      const language = require(`@tesseract.js-data/${code}`) as { langPath: string };
      await cp(
        join(language.langPath, `${code}.traineddata.gz`),
        join(directory, `${code}.traineddata.gz`),
      );
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function assertBoundedImage(bytes: Buffer, mediaType: string) {
  let width = 0;
  let height = 0;
  if (mediaType === "image/png" && bytes.length >= 24) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1] ?? 0;
      if ([192, 193, 194].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += length + 2;
    }
  }
  if (!width || !height || width * height > 16000000 || width > 16000 || height > 16000)
    throw new AttachmentError("OCR image dimensions exceed the supported bound.", 413);
}
