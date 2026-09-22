import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeExecutionError } from "./agent-observations.js";
import { createPythonAgentExecutor, superviseRuntimeProcess } from "./agent-runtime-process.js";
import { RUNTIME_CONTROL_PROMPT, RUNTIME_PROTOCOL } from "./agent-runtime-wire.js";

// An adversarial transport fixture, not a Python SDK integration or provider simulation claim.
const worker = String.raw`
const {createInterface} = require('node:readline');
const {writeFileSync} = require('node:fs');
const {spawn} = require('node:child_process');
const config = JSON.parse(process.argv[1]);
const input = createInterface({input: process.stdin});
const send = (message) => process.stdout.write(JSON.stringify(message)+'\n');
const request = (id,method,params={}) => send({jsonrpc:'2.0',id,method,params});
const finish = () => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'run',result:{text:'Delivered.'}})+'\n', () => process.exit(0));
input.on('line', line => {
 const message=JSON.parse(line);
 if (message.id==='run') {
  if (config.output && config.mode!=='descendant') writeFileSync(config.output,JSON.stringify({pid:process.pid,cwd:process.cwd(),env:process.env}));
  switch(config.mode) {
   case 'valid': request('w1','authority.check'); break;
   case 'malformed': process.stdout.write('not-json\n'); break;
   case 'bad-utf8': process.stdout.write(Buffer.from([0xc3,0x28,10])); break;
   case 'partial': process.stdout.write('{"jsonrpc":'); process.exitCode=0; input.close(); process.stdin.destroy(); break;
   case 'crash': process.exit(2); break;
   case 'no-final': process.exit(0); break;
   case 'stdout-flood': process.stdout.write('x'.repeat(524289)); break;
   case 'stderr-flood': process.stderr.write('s'.repeat(65537)); break;
   case 'unknown': request('w1','approval.grant'); break;
   case 'parallel': request('w1','authority.check'); request('w2','authority.check'); break;
   case 'duplicate': request('w1','authority.check'); break;
   case 'port-failure': request('w1','authority.check'); break;
   case 'final-extra': send({jsonrpc:'2.0',id:'run',result:{text:'Delivered.'}}); request('w1','authority.check'); break;
   case 'hung-final': send({jsonrpc:'2.0',id:'run',result:{text:'Delivered.'}}); break;
   case 'hang': process.on('SIGTERM',()=>{}); break;
   case 'descendant': {
    process.on('SIGTERM',()=>{});
    const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
    writeFileSync(config.output,JSON.stringify({pid:process.pid,descendant:descendant.pid,cwd:process.cwd()})); break;
   }
  }
 } else if(config.mode==='duplicate') request('w1','authority.check');
 else if(config.mode==='valid') {
  if(message.id==='w1') request('w2','model.generate',{messages:[{role:'user',content:'Continue the Server-bound task.'}]});
  else if(message.id==='w2') request('w3','tool.execute',message.result.tools[0]);
  else if(message.id==='w3') request('w4','model.generate',{messages:[{role:'user',content:'Continue the Server-bound task.'},{role:'assistant',content:[{type:'tool-call',toolCallId:'c1',toolName:'read',input:{}}]},{role:'tool',content:[{type:'tool-result',toolCallId:'c1',toolName:'read',output:{type:'json',value:message.result.value}}]}]});
  else if(message.id==='w4') finish();
 }
});
`;
const directories: string[] = [];
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0))
    controller.abort(new NativeExecutionError("server_interrupted"));
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function start(mode: string, output?: string, controller = new AbortController()) {
  controllers.push(controller);
  let steps = 0;
  const dispatch = vi.fn(async (request: { method: string }) => {
    if (mode === "parallel") await new Promise(() => {});
    if (mode === "port-failure") throw new NativeExecutionError("scope_revoked");
    if (request.method === "model.generate")
      return ++steps === 1
        ? {
            text: "",
            tools: [{ id: "c1", name: "read", arguments: {} }],
            usage: { inputTokens: null, outputTokens: 1 },
          }
        : { text: "Delivered.", tools: [], usage: { inputTokens: 1, outputTokens: 1 } };
    if (request.method === "tool.execute") return { value: { evidence: "facts" } };
    return {};
  });
  const result = superviseRuntimeProcess({
    executable: process.execPath,
    args: ["--input-type=commonjs", "-e", worker, JSON.stringify({ mode, output })],
    controller,
    invocation: {
      jsonrpc: "2.0",
      id: "run",
      method: "runtime.execute",
      params: { protocol: RUNTIME_PROTOCOL, tools: [], deadlineMs: 3000 },
    },
    dispatch,
  });
  return { result, controller, dispatch };
}
async function outputPath() {
  const directory = await mkdtemp(join(tmpdir(), "openbot-runtime-test-"));
  directories.push(directory);
  return join(directory, "state.json");
}
async function state(
  path: string,
): Promise<{ pid: number; descendant?: number; cwd: string; env: Record<string, string> }> {
  let result: Awaited<ReturnType<typeof state>> | undefined;
  await vi.waitFor(
    async () => {
      result = JSON.parse(await readFile(path, "utf8"));
      expect(result?.pid).toBeGreaterThan(0);
    },
    { timeout: 2500 },
  );
  if (!result) throw new Error("fixture failed to start");
  return result;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe.skipIf(process.platform === "win32")("owned runtime subprocess lifecycle", () => {
  it("waits for clean exit and dispatches sequential model/tool traffic with a minimal environment", async () => {
    vi.stubEnv("OPENBOT_TEST_PRIVATE_CANARY", "must-not-inherit");
    const output = await outputPath();
    const run = start("valid", output);
    await expect(run.result).resolves.toBe("Delivered.");
    expect(run.dispatch.mock.calls.map(([request]) => request.method)).toEqual([
      "authority.check",
      "model.generate",
      "tool.execute",
      "model.generate",
    ]);
    expect(run.dispatch.mock.calls[1]?.[0]).toMatchObject({
      params: { messages: [{ role: "user", content: RUNTIME_CONTROL_PROMPT }] },
    });
    expect(run.dispatch.mock.calls[3]?.[0]).toMatchObject({
      params: {
        messages: [
          { role: "user" },
          { role: "assistant" },
          { role: "tool", content: [{ output: { value: { evidence: "facts" } } }] },
        ],
      },
    });
    const child = await state(output);
    expect(child.env).toMatchObject({ LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
    expect(child.env.OPENBOT_TEST_PRIVATE_CANARY).toBeUndefined();
    expect(
      Object.keys(child.env).filter(
        (name) =>
          !["LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING"].includes(name) &&
          // The Node fixture in Linux/amd64 emulation adds this even under env -i.
          !(process.platform === "linux" && name === "UV_USE_IO_URING" && child.env[name] === "0"),
      ),
    ).toEqual([]);
    expect(alive(child.pid)).toBe(false);
    await expect(readFile(join(child.cwd, "anything"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "malformed",
    "bad-utf8",
    "partial",
    "crash",
    "no-final",
    "stdout-flood",
    "stderr-flood",
    "unknown",
    "parallel",
    "duplicate",
    "final-extra",
    "hung-final",
  ])("refuses %s and closes the owned process", async (mode) => {
    const output = await outputPath();
    const run = start(mode, output);
    await expect(run.result).rejects.toMatchObject({ code: "tool_unavailable" });
    expect(run.controller.signal.aborted).toBe(true);
    const child = await state(output);
    expect(alive(child.pid)).toBe(false);
    if (mode === "parallel") expect(run.dispatch.mock.calls.length).toBeLessThanOrEqual(1);
    else expect(run.dispatch).toHaveBeenCalledTimes(mode === "duplicate" ? 1 : 0);
  });

  it("preserves the first Server port refusal", async () => {
    const run = start("port-failure");
    await expect(run.result).rejects.toMatchObject({ code: "scope_revoked" });
    expect(run.dispatch).toHaveBeenCalledOnce();
  });

  it.each(["hang", "descendant"])(
    "cancels %s and kills the invocation group even when SIGTERM is ignored",
    async (mode) => {
      const output = await outputPath();
      const run = start(mode, output);
      const rejected = expect(run.result).rejects.toMatchObject({ code: "server_interrupted" });
      const child = await state(output);
      run.controller.abort(new NativeExecutionError("server_interrupted"));
      await rejected;
      expect(alive(child.pid)).toBe(false);
      if (child.descendant)
        await vi.waitFor(() => expect(alive(child.descendant as number)).toBe(false), {
          timeout: 2500,
        });
    },
  );

  it("does not spawn after cancellation or accept task-selected executable paths", async () => {
    const controller = new AbortController();
    controller.abort(new NativeExecutionError("scope_revoked"));
    await expect(start("valid", undefined, controller).result).rejects.toMatchObject({
      code: "scope_revoked",
    });
    expect(() =>
      createPythonAgentExecutor({
        pythonExecutable: "python",
        workerEntrypoint: "/fixed/run-worker.py",
      }),
    ).toThrow();
    expect(() =>
      createPythonAgentExecutor({
        pythonExecutable: process.execPath,
        workerEntrypoint: "/fixed/run-worker.py",
        deadlineMs: 0,
      }),
    ).toThrow();
  });
  it("bounds a hung catalog authority check before spawning any child", async () => {
    const execute = createPythonAgentExecutor({
      pythonExecutable: process.execPath,
      workerEntrypoint: "/missing/runtime.py",
      deadlineMs: 20,
    });
    const model = new MockLanguageModelV4({});
    await expect(
      execute(
        {
          model: { languageModel: model, identity: { provider: "openai", model: "fixture" } },
          authority: { assertActive: () => new Promise(() => {}) },
          tools: {
            definitions: {},
            policies: {},
            classifyError: () => new NativeExecutionError("tool_unavailable"),
          },
          storage: { corrections: async () => [], saveUsage: async () => {} },
          audit: { progress: async () => {} },
        },
        {
          instructions: "Bound task",
          messages: [{ role: "user", content: "task" }],
          signal: new AbortController().signal,
          budget: { steps: 0, tools: 0, web: 0 },
        },
      ),
    ).rejects.toMatchObject({ code: "task_limit" });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("handles a missing installed executable without leaving a child or accepting success", async () => {
    const controller = new AbortController();
    await expect(
      superviseRuntimeProcess({
        executable: "/nonexistent-openbot-test-runtime",
        args: [],
        controller,
        invocation: { jsonrpc: "2.0", id: "run", method: "runtime.execute", params: {} },
        dispatch: async () => ({}),
      }),
    ).rejects.toMatchObject({ code: "tool_unavailable" });
    expect(controller.signal.aborted).toBe(true);
  });
});
