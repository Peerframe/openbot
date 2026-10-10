/** Adapts Server lifecycle diagnostics to the shared allowlist without serializing requests or errors. */
import {
  createLogger,
  diagnosticFields,
  type LogFields,
  type OpenBotLogger,
} from "@openbot/logging";
import type { FastifyBaseLogger } from "fastify";
import { HttpFailure } from "./http-errors.js";

export class StartupFailure extends Error {
  readonly phase: string;
  constructor(phase: string, cause: unknown) {
    super("Server startup refused.", { cause });
    this.name = "StartupFailure";
    this.phase = phase;
  }
}
export async function startup<T>(phase: string, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new StartupFailure(phase, cause);
  }
}
/** Private Desktop child contract: only a failed Temporal connection requests dependency waiting. */
export function desktopStartupExitCode(error: unknown): 1 | 75 {
  return failureFields(error).phase === "temporal-connect" ? 75 : 1;
}
export const serverLog = createLogger({ level: "info" });
const systemCodes = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EADDRINUSE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
]);
export function failureFields(error: unknown): LogFields {
  const fields = diagnosticFields(error);
  // Traverse bounded causal chains, retaining only public refusal/driver identifiers.
  for (let depth = 0; depth < 5 && error instanceof Error; depth++, error = error.cause) {
    if (error instanceof StartupFailure) fields.phase = error.phase;
    if (error instanceof HttpFailure) {
      fields.status ??= error.status;
      if (/^[a-z][a-z0-9_]{0,79}$/.test(error.body.error)) fields.code ??= error.body.error;
    }
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string" && (systemCodes.has(code) || /^[0-9A-Z]{5}$/.test(code)))
      fields.code ??= code;
  }
  return fields;
}
export function reportFailure(phase: string, error: unknown, fields: LogFields = {}) {
  const level = error instanceof HttpFailure && error.status < 500 ? "debug" : "error";
  serverLog[level]("server.operation_failed", "Server operation failed.", {
    phase,
    ...failureFields(error),
    ...fields,
  });
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

export function httpLogger(logger: OpenBotLogger = serverLog): FastifyBaseLogger {
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (...args: unknown[]) => {
      const data = record(args[0]),
        response = record(data.res),
        request = record(data.req);
      const fields: LogFields = data.err ? failureFields(data.err) : {};
      if (typeof response.statusCode === "number") fields.status = response.statusCode;
      if (typeof data.responseTime === "number") fields.durationMs = data.responseTime;
      if (
        typeof request.method === "string" &&
        /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method)
      )
        fields.method = request.method;
      // Fastify messages may contain arbitrary exception text; emit a fixed message instead.
      logger[level]("server.http", "Server HTTP lifecycle event.", fields);
    };
  return {
    level: "info",
    fatal: write("error"),
    error: write("error"),
    warn: write("warn"),
    info: write("info"),
    debug: write("debug"),
    trace: write("debug"),
    silent: () => {},
    child(bindings: unknown) {
      const requestId = record(bindings).reqId;
      return httpLogger(
        logger.child(
          typeof requestId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(requestId)
            ? { requestId }
            : {},
        ),
      );
    },
  };
}
