import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { NativeExecutionError } from "./agent-observations.js";
import { AgentRuntimeHost } from "./agent-runtime-host.js";
import {
  restoreRuntimeMessages,
  RUNTIME_PROTOCOL,
  RuntimeFrameReader,
  RuntimeFrameWriter,
  runtimeProtocolFailure,
  runtimeWorkerMessageSchema,
  type RuntimeWorkerRequest,
} from "./agent-runtime-wire.js";
import type { AgentRuntimeExecutor } from "./agent-runtime.js";
import { abortable } from "./agent-stream.js";

export interface PythonRuntimeOptions {
  /** Trusted Server deployment configuration, never supplied in a task or API request. */
  pythonExecutable: string;
  workerEntrypoint: string;
  deadlineMs?: number;
}

interface ProcessOptions {
  executable: string;
  args: string[];
  controller: AbortController;
  invocation: JSONRPCMessage;
  dispatch(request: RuntimeWorkerRequest): Promise<Record<string, unknown>>;
}

const LOCAL_LIMIT_REASONS = new Set([
  "deadline_exceeded",
  "step_limit",
  "tool_call_limit",
  "message_limit",
  "output_limit",
  "catalog_limit",
  "limit_exceeded",
]);

/** Internal trusted-code seam for lifecycle fixtures. No arbitrary-command endpoint is exposed. */
export async function superviseRuntimeProcess(options: ProcessOptions): Promise<string> {
  if (process.platform === "win32" || !isAbsolute(options.executable))
    throw new NativeExecutionError("invalid_target");
  const signal = options.controller.signal;
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "openbot-runtime-"));
  try {
    signal.throwIfAborted();
    return await runOwnedProcess(options, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runOwnedProcess(options: ProcessOptions, directory: string): Promise<string> {
  const child = spawn(options.executable, options.args, {
    cwd: directory,
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    shell: false,
  });
  const completed = deferred<string>();
  const closed = deferred<void>();
  const reader = new RuntimeFrameReader();
  const writer = new RuntimeFrameWriter();
  const signal = options.controller.signal;
  let failed = false;
  let isClosed = false;
  let busy = false;
  let nextId = 1;
  let finalText: string | undefined;
  let stderrBytes = 0;
  let finalExitTimer: ReturnType<typeof setTimeout> | undefined;

  function fail(error: unknown = runtimeProtocolFailure()): void {
    if (failed) return;
    failed = true;
    // Abort Server operations too; no late model response may write usage or release a tool result.
    const reason = error instanceof NativeExecutionError ? error : runtimeProtocolFailure();
    completed.reject(reason);
    options.controller.abort(reason);
  }
  function onAbort(): void {
    fail(signal.reason);
  }
  function send(message: JSONRPCMessage): void {
    if (failed || signal.aborted) return;
    try {
      child.stdin.write(writer.encode(message), (error) => {
        if (error) fail();
      });
    } catch {
      fail();
    }
  }
  function receive(raw: JSONRPCMessage): void {
    if (failed) return;
    try {
      if (finalText !== undefined || busy) throw runtimeProtocolFailure();
      const message = runtimeWorkerMessageSchema.parse(raw);
      if ("error" in message) {
        throw new NativeExecutionError(
          LOCAL_LIMIT_REASONS.has(message.error.data.reason) ? "task_limit" : "tool_unavailable",
        );
      }
      if ("result" in message) {
        if (!message.result.text.trim()) throw runtimeProtocolFailure();
        finalText = message.result.text;
        // A result with a hung child is not a completed invocation.
        finalExitTimer = setTimeout(() => fail(), 1000);
        return;
      }
      if (nextId > 512 || message.id !== `w${nextId++}`) throw runtimeProtocolFailure();
      busy = true;
      void Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return options.dispatch(message);
        })
        .then((result) => {
          if (failed || signal.aborted) return;
          busy = false;
          send({ jsonrpc: "2.0", id: message.id, result });
        }, fail);
    } catch (error) {
      fail(error);
    }
  }

  child.on("error", () => fail());
  child.stdin.on("error", () => fail());
  child.stdout.on("error", () => fail());
  child.stderr.on("error", () => fail());
  child.stdout.on("data", (chunk: Buffer) => {
    if (failed) return;
    try {
      for (const message of reader.push(chunk)) receive(message);
    } catch {
      fail();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    // Never retain or log stderr: imported code can print task data or private exception values.
    if (stderrBytes > 64 * 1024) fail();
  });
  child.on("close", (code, exitSignal) => {
    isClosed = true;
    closed.resolve(undefined);
    if (finalExitTimer) clearTimeout(finalExitTimer);
    if (failed) return;
    try {
      reader.finish();
      if (code !== 0 || exitSignal || busy || finalText === undefined || signal.aborted)
        throw runtimeProtocolFailure();
      completed.resolve(finalText);
    } catch {
      fail();
    }
  });
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  send(options.invocation);

  const outcome = await completed.promise.then(
    (text) => ({ text }),
    (error: unknown) => ({ error }),
  );
  try {
    signal.removeEventListener("abort", onAbort);
    if (finalExitTimer) clearTimeout(finalExitTimer);
    child.stdin.destroy();
    // The group is invocation-owned, including descendants that inherited a pipe after leader exit.
    const terminateGroup = (killSignal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, killSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw runtimeProtocolFailure();
      }
    };
    terminateGroup("SIGTERM");
    if (!isClosed) await waitForClose(closed.promise, 250);
    terminateGroup("SIGKILL");
    if (!isClosed && !(await waitForClose(closed.promise, 1000))) {
      child.stdout.destroy();
      child.stderr.destroy();
      throw runtimeProtocolFailure();
    }
  } catch (error) {
    // Cleanup can prevent success, but it cannot replace an earlier Server denial.
    if ("error" in outcome) throw outcome.error;
    throw error;
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.text;
}

async function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Selectable by reviewed Server composition only; existing production composition stays unchanged. */
export function createPythonAgentExecutor(options: PythonRuntimeOptions): AgentRuntimeExecutor {
  const deadlineMs = options.deadlineMs ?? 300_000;
  if (
    !isAbsolute(options.pythonExecutable) ||
    !isAbsolute(options.workerEntrypoint) ||
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 300_000
  )
    throw new NativeExecutionError("invalid_target");
  return async (ports, input) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    const timer = setTimeout(
      () => controller.abort(new NativeExecutionError("task_limit")),
      deadlineMs,
    );
    const host = new AgentRuntimeHost(ports, { ...input, signal: controller.signal });
    try {
      const tools = await abortable(host.catalog(), controller.signal);
      const text = await superviseRuntimeProcess({
        executable: options.pythonExecutable,
        args: ["-I", "-u", options.workerEntrypoint],
        controller,
        invocation: {
          jsonrpc: "2.0",
          id: "run",
          method: "runtime.execute",
          params: { protocol: RUNTIME_PROTOCOL, tools, deadlineMs },
        },
        dispatch: async (request) => {
          if (request.method === "authority.check") {
            await host.assertActive();
            return {};
          }
          if (request.method === "tool.execute")
            return { value: await host.executeTool(request.params) };
          const result = await host.generate(
            restoreRuntimeMessages(request.params.messages, input.messages),
          );
          return { text: result.text, tools: result.tools, usage: result.usage };
        },
      });
      return await host.finish(text);
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      controller.abort(new NativeExecutionError("server_interrupted"));
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
