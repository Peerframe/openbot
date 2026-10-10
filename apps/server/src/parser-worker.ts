/** Fixed byte-to-text adapter for OpenBot's already-reviewed parsers; no business authority. */

import dgram from "node:dgram";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import workerThreads from "node:worker_threads";
import type { WorkerOptions } from "node:worker_threads";

type Require = ReturnType<typeof createRequire>;
type PdfJsModule = typeof import("pdfjs-dist");
type OfficeParserModule = typeof import("officeparser");
type TesseractModule = typeof import("tesseract.js");

type ParserOperation = "extract" | "ocr";

type ParserHeader = {
  readonly operation: ParserOperation;
  readonly extension: string;
  readonly password?: string;
  readonly size: number;
};

type ParserJob = ParserHeader & {
  readonly bytes: Buffer;
};

type ParserSuccess = {
  readonly text: string;
  readonly truncated: boolean;
};

type ParserErrorCode =
  | "pdf_password_required"
  | "parser_dependency_unavailable"
  | "attachment_parsing_failed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function denied(): never {
  throw new Error("parser_network_refused");
}

// This file is also a preload, inherited by the released OCR worker. Parsers only receive
// bytes and installed language/font paths: no URL, inherited credential or network fallback.
globalThis.fetch = denied;
net.connect = net.createConnection = net.Socket.prototype.connect = denied;
tls.connect = http.request = http.get = https.request = https.get = denied;
dgram.createSocket = denied;

const { isMainThread, Worker: ParserWorker } = workerThreads;
// Node 22 does not execute --import preloads in every CommonJS Worker entry. Tesseract's
// reviewed Node launcher uses one absolute CommonJS workerPath, so prepend this same fixed
// guard explicitly before loading it. No worker source/path comes from attachment contents.
workerThreads.Worker = class extends ParserWorker {
  constructor(filename: string | URL | null, options: WorkerOptions = {}) {
    if (typeof filename !== "string" || !path.isAbsolute(filename) || options.eval)
      throw new Error("parser_worker_refused");
    const entry = `(async()=>{await import(${JSON.stringify(import.meta.url)});require(${JSON.stringify(filename)});})().catch(()=>process.exit(1));`;
    super(entry, {
      ...options,
      eval: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });
  }
};
syncBuiltinESMExports();

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 262144;
const OFFICE_EXTENSIONS = ["docx", "xlsx", "pptx", "odt", "ods", "odp"] as const;
const ownPath = fileURLToPath(import.meta.url);
const output = process.stdout.write.bind(process.stdout);

function parseHeader(value: unknown, byteLength: number): ParserHeader {
  if (!isRecord(value)) throw new Error("parser_input_invalid");
  if (
    Object.keys(value).some((key) => !["operation", "extension", "password", "size"].includes(key))
  )
    throw new Error("parser_input_invalid");
  const operation = value.operation;
  const extension = value.extension;
  const password = value.password;
  const size = value.size;
  if (operation !== "extract" && operation !== "ocr") throw new Error("parser_input_invalid");
  if (typeof extension !== "string") throw new Error("parser_input_invalid");
  if (password !== undefined && (typeof password !== "string" || password.length > 256))
    throw new Error("parser_input_invalid");
  if (size !== byteLength || byteLength === 0 || byteLength > MAX_BYTES)
    throw new Error("parser_input_invalid");
  if (password === undefined) return { operation, extension, size };
  return { operation, extension, password, size };
}

async function receive(): Promise<ParserJob> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += piece.length;
    if (size > MAX_BYTES + 4097) throw new Error("parser_input_limit");
    chunks.push(piece);
  }
  const input = Buffer.concat(chunks);
  const end = input.indexOf(10);
  if (end < 0 || end > 4096) throw new Error("parser_input_invalid");
  let headerUnknown: unknown;
  try {
    headerUnknown = JSON.parse(input.subarray(0, end).toString("utf8")) as unknown;
  } catch {
    throw new Error("parser_input_invalid");
  }
  const bytes = input.subarray(end + 1);
  const header = parseHeader(headerUnknown, bytes.length);
  return { ...header, bytes };
}

async function packageInfo(require: Require, name: string): Promise<{ version?: unknown }> {
  let current = path.dirname(require.resolve(name));
  for (let depth = 0; depth < 8; depth++) {
    try {
      const raw: unknown = JSON.parse(
        await fs.readFile(path.join(current, "package.json"), "utf8"),
      );
      if (!isRecord(raw)) throw new Error("parser_dependency_unavailable");
      if (raw.name === name) return { version: raw.version };
    } catch (error: unknown) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
  throw new Error("parser_dependency_unavailable");
}

async function assertPinnedDependencies(require: Require): Promise<void> {
  try {
    for (const [name, version] of [
      ["pdfjs-dist", "6.3.289"],
      ["officeparser", "7.8.0"],
      ["tesseract.js", "7.0.0"],
      ["@tesseract.js-data/eng", "1.0.0"],
      ["@tesseract.js-data/chi_sim", "1.0.0"],
    ] as const) {
      if ((await packageInfo(require, name)).version !== version)
        throw new Error("parser_dependency_unavailable");
    }
  } catch {
    throw new Error("parser_dependency_unavailable");
  }
}

async function adaptOcr(
  require: Require,
  languageDirectory: string,
  bytes: Buffer,
): Promise<string> {
  for (const language of ["eng", "chi_sim"] as const) {
    const packUnknown: unknown = require(`@tesseract.js-data/${language}`);
    if (!isRecord(packUnknown) || typeof packUnknown.langPath !== "string")
      throw new Error("parser_dependency_unavailable");
    await fs.copyFile(
      path.join(packUnknown.langPath, `${language}.traineddata.gz`),
      path.join(languageDirectory, `${language}.traineddata.gz`),
    );
  }
  const { createWorker } = (await import(
    pathToFileURL(require.resolve("tesseract.js")).href
  )) as TesseractModule;
  const worker = await createWorker("eng+chi_sim", 1, {
    langPath: languageDirectory,
    gzip: true,
    cacheMethod: "none",
    logger: () => {},
  });
  try {
    const text = (await worker.recognize(bytes)).data.text;
    if (typeof text !== "string") throw new Error("parser_response_invalid");
    return text;
  } finally {
    await worker.terminate();
  }
}

function isOfficeExtension(extension: string): extension is (typeof OFFICE_EXTENSIONS)[number] {
  return (OFFICE_EXTENSIONS as readonly string[]).includes(extension);
}

async function adaptPdf(
  require: Require,
  bytes: Buffer,
  password: string | undefined,
): Promise<{ text: string; truncated: boolean }> {
  const pdfPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const { getDocument } = (await import(pathToFileURL(pdfPath).href)) as PdfJsModule;
  const fonts = `${path.resolve(path.dirname(pdfPath), "../../standard_fonts")}/`;
  const parameters = {
    data: Uint8Array.from(bytes),
    password,
    standardFontDataUrl: fonts.replaceAll("\\", "/"),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    stopAtErrors: true,
  };
  const task = getDocument(parameters);
  let text = "";
  let truncated = false;
  try {
    const pdf = await task.promise;
    const pages = Math.min(pdf.numPages, 200);
    truncated = pages < pdf.numPages;
    for (let page = 1; page <= pages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      for (const item of content.items) {
        if (typeof item !== "object" || item === null || !("str" in item)) continue;
        if (typeof item.str !== "string") continue;
        text += item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ");
      }
      text += "\n";
      if (text.length > MAX_TEXT) {
        truncated = true;
        break;
      }
    }
  } finally {
    await task.destroy();
  }
  return { text, truncated };
}

async function adaptOffice(require: Require, bytes: Buffer, extension: string): Promise<string> {
  if (!isOfficeExtension(extension)) throw new Error("parser_input_invalid");
  const { OfficeParser } = (await import(
    pathToFileURL(require.resolve("officeparser")).href
  )) as OfficeParserModule;
  const ast = await OfficeParser.parseOffice(bytes, {
    fileType: extension,
    ocr: false,
    extractAttachments: false,
    decompressionLimits: {
      maxUncompressedBytes: 33554432,
      maxZipEntries: 2000,
      maxTableCells: 100000,
    },
  });
  const text = ast.toText();
  if (typeof text !== "string") throw new Error("parser_response_invalid");
  return text;
}

async function parse(): Promise<ParserSuccess> {
  const moduleRootArg = process.argv[2];
  const languageDirectoryArg = process.argv[3];
  if (typeof moduleRootArg !== "string" || typeof languageDirectoryArg !== "string")
    throw new Error("parser_configuration");
  if (!path.isAbsolute(moduleRootArg) || !path.isAbsolute(languageDirectoryArg))
    throw new Error("parser_configuration");
  const moduleRoot = moduleRootArg;
  const languageDirectory = languageDirectoryArg;
  const require = createRequire(path.join(moduleRoot, "openbot-parser.cjs"));
  await assertPinnedDependencies(require);
  const { bytes, extension, password, operation } = await receive();
  // Upstream diagnostic text must never contaminate the bounded JSON protocol or expose input.
  console.log = console.warn = console.error = () => {};
  let text = "";
  let truncated = false;
  if (operation === "ocr") {
    text = await adaptOcr(require, languageDirectory, bytes);
  } else if (extension === "pdf") {
    const pdf = await adaptPdf(require, bytes, password);
    text = pdf.text;
    truncated = pdf.truncated;
  } else {
    text = await adaptOffice(require, bytes, extension);
  }
  if (typeof text !== "string") throw new Error("parser_response_invalid");
  return { text: text.slice(0, MAX_TEXT), truncated: truncated || text.length > MAX_TEXT };
}

function classifyError(error: unknown): ParserErrorCode {
  const record = error as { name?: unknown; message?: unknown } | null | undefined;
  return record?.name === "PasswordException"
    ? "pdf_password_required"
    : record?.message === "parser_dependency_unavailable"
      ? "parser_dependency_unavailable"
      : "attachment_parsing_failed";
}

if (isMainThread && path.resolve(process.argv[1] || "") === ownPath) {
  try {
    output(JSON.stringify(await parse()));
  } catch (error: unknown) {
    output(JSON.stringify({ error: classifyError(error) }));
  }
}
