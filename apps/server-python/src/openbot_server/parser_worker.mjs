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

// This file is also a preload, inherited by the released OCR worker. Parsers only receive
// bytes and installed language/font paths: no URL, inherited credential or network fallback.
const denied = () => {
  throw new Error("parser_network_refused");
};
globalThis.fetch = denied;
net.connect = net.createConnection = net.Socket.prototype.connect = denied;
tls.connect = http.request = http.get = https.request = https.get = denied;
dgram.createSocket = denied;
const { isMainThread, Worker: ParserWorker } = workerThreads;
// Node 22 does not execute --import preloads in every CommonJS Worker entry. Tesseract's
// reviewed Node launcher uses one absolute CommonJS workerPath, so prepend this same fixed
// guard explicitly before loading it. No worker source/path comes from attachment contents.
workerThreads.Worker = class extends ParserWorker {
  constructor(filename, options = {}) {
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
const ownPath = fileURLToPath(import.meta.url);
const output = process.stdout.write.bind(process.stdout);

async function receive() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES + 4097) throw new Error("parser_input_limit");
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  const end = input.indexOf(10);
  if (end < 0 || end > 4096) throw new Error("parser_input_invalid");
  const header = JSON.parse(input.subarray(0, end).toString("utf8"));
  const bytes = input.subarray(end + 1);
  if (
    !header ||
    Object.keys(header).some(
      (key) => !["operation", "extension", "password", "size"].includes(key),
    ) ||
    !["extract", "ocr"].includes(header.operation) ||
    typeof header.extension !== "string" ||
    (header.password !== undefined &&
      (typeof header.password !== "string" || header.password.length > 256)) ||
    header.size !== bytes.length ||
    !bytes.length ||
    bytes.length > MAX_BYTES
  )
    throw new Error("parser_input_invalid");
  return { ...header, bytes };
}

function packageInfo(require, name) {
  let current = path.dirname(require.resolve(name));
  return (async () => {
    for (let depth = 0; depth < 8; depth++) {
      try {
        const value = JSON.parse(await fs.readFile(path.join(current, "package.json"), "utf8"));
        if (value.name === name) return value;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      current = path.dirname(current);
    }
    throw new Error("parser_dependency_unavailable");
  })();
}

async function parse() {
  const moduleRoot = process.argv[2];
  const languageDirectory = process.argv[3];
  if (!path.isAbsolute(moduleRoot || "") || !path.isAbsolute(languageDirectory || ""))
    throw new Error("parser_configuration");
  const require = createRequire(path.join(moduleRoot, "openbot-parser.cjs"));
  try {
    for (const [name, version] of [
      ["pdfjs-dist", "6.3.289"],
      ["officeparser", "7.8.0"],
      ["tesseract.js", "7.0.0"],
      ["@tesseract.js-data/eng", "1.0.0"],
      ["@tesseract.js-data/chi_sim", "1.0.0"],
    ]) {
      if ((await packageInfo(require, name)).version !== version)
        throw new Error("parser_dependency_unavailable");
    }
  } catch {
    throw new Error("parser_dependency_unavailable");
  }
  const { bytes, extension, password, operation } = await receive();
  let text = "",
    truncated = false;
  // Upstream diagnostic text must never contaminate the bounded JSON protocol or expose input.
  console.log = console.warn = console.error = () => {};
  if (operation === "ocr") {
    for (const language of ["eng", "chi_sim"]) {
      const source = require(`@tesseract.js-data/${language}`).langPath;
      await fs.copyFile(
        path.join(source, `${language}.traineddata.gz`),
        path.join(languageDirectory, `${language}.traineddata.gz`),
      );
    }
    const { createWorker } = await import(pathToFileURL(require.resolve("tesseract.js")).href);
    const worker = await createWorker("eng+chi_sim", 1, {
      langPath: languageDirectory,
      gzip: true,
      cacheMethod: "none",
      logger: () => {},
    });
    try {
      text = (await worker.recognize(bytes)).data.text;
    } finally {
      await worker.terminate();
    }
  } else if (extension === "pdf") {
    const pdfPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    const { getDocument } = await import(pathToFileURL(pdfPath).href);
    const fonts = `${path.resolve(path.dirname(pdfPath), "../../standard_fonts")}/`;
    const task = getDocument({
      data: Uint8Array.from(bytes),
      password,
      standardFontDataUrl: fonts.replaceAll("\\", "/"),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      stopAtErrors: true,
    });
    try {
      const pdf = await task.promise;
      const pages = Math.min(pdf.numPages, 200);
      truncated = pages < pdf.numPages;
      for (let page = 1; page <= pages; page++) {
        const content = await (await pdf.getPage(page)).getTextContent();
        for (const item of content.items)
          if (typeof item.str === "string") text += item.str + (item.hasEOL ? "\n" : " ");
        text += "\n";
        if (text.length > MAX_TEXT) {
          truncated = true;
          break;
        }
      }
    } finally {
      await task.destroy();
    }
  } else {
    if (!["docx", "xlsx", "pptx", "odt", "ods", "odp"].includes(extension))
      throw new Error("parser_input_invalid");
    const { OfficeParser } = await import(pathToFileURL(require.resolve("officeparser")).href);
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
    text = ast.toText();
  }
  if (typeof text !== "string") throw new Error("parser_response_invalid");
  return { text: text.slice(0, MAX_TEXT), truncated: truncated || text.length > MAX_TEXT };
}

if (isMainThread && path.resolve(process.argv[1] || "") === ownPath) {
  try {
    output(JSON.stringify(await parse()));
  } catch (error) {
    output(
      JSON.stringify({
        error:
          error?.name === "PasswordException"
            ? "pdf_password_required"
            : error?.message === "parser_dependency_unavailable"
              ? "parser_dependency_unavailable"
              : "attachment_parsing_failed",
      }),
    );
  }
}
