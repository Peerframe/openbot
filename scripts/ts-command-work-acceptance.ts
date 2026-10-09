import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { OpenBotNodeClient } from "../apps/node/dist/client.js";
import { unixCommandInstallation } from "../apps/node/dist/command-unix-transport.js";
import type { NodeCredentialStore } from "../apps/node/dist/credential-store.js";
import { nodeEnvSchema } from "../packages/config/dist/index.js";
import type { OpenBotLogger } from "../packages/logging/dist/index.js";
import {
  nodeEnrollmentTokenResponseSchema,
  workSnapshotWireSchema,
} from "../packages/protocol/dist/index.js";
import { allowlistedEnvironment } from "./python-acceptance-fixture.ts";

export const commandCsv = Buffer.from("label,value\nalpha,12\nbeta,8\ngamma,5\n");
export const commandArguments = {
  argv: ["/bin/cp", "/input/input-01", "/output/result.csv"],
  output: { name: "result.csv", mediaType: "text/csv", maxBytes: 65536 },
};
export async function commandWorkFixture(python: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "obcmd-")));
  const route = {
    nodeId: "p4-command-" + randomUUID(),
    providerId: "linux-command",
    enforcementKeyId: "product-enforcer-key",
    ledgerId: randomUUID(),
  };
  const timing = {
    prepareBudgetMs: 30000,
    challengeBudgetMs: 5000,
    runtimeMaxMs: 50000,
    stopAllowanceMs: 5000,
    clockRateErrorPpm: 1000,
    clockQuantizationMs: 100,
    policyDigest: "e".repeat(64),
  };
  const control = generateKeyPairSync("ed25519"),
    enforcer = generateKeyPairSync("ed25519");
  const controlPublic = control.publicKey.export({ type: "spki", format: "pem" }).toString(),
    enforcerPrivate = enforcer.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const configPath = join(directory, "command.json");
  let child: ReturnType<typeof spawn> | undefined, node: OpenBotNodeClient | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await node?.stop();
    if (child && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.stdin?.end(JSON.stringify({ operation: "close" }) + "\n");
      const timer = setTimeout(() => child!.kill("SIGTERM"), 6000);
      try {
        await ended;
      } finally {
        clearTimeout(timer);
      }
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await writeFile(
      join(directory, "control.pem"),
      control.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "enforcer.pub"),
      enforcer.publicKey.export({ type: "spki", format: "pem" }),
      { mode: 0o600 },
    );
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        route,
        timing,
        policy: {
          id: "offline-command",
          image: "python@sha256:" + "a".repeat(64),
          limits: {
            nanoCPUs: 1000000000,
            memoryMiB: 256,
            pids: 128,
            nofile: 64,
            tmpMiB: 16,
            wallSeconds: 60,
            outputMiB: 64,
            capturedOutputKiB: 1024,
          },
        },
        control: {
          issuer: "product-control",
          keyId: "product-control-key",
          privateKeyPath: join(directory, "control.pem"),
        },
        enforcement: {
          issuer: "product-enforcer",
          keyId: route.enforcementKeyId,
          publicKeyPath: join(directory, "enforcer.pub"),
        },
      }),
      { mode: 0o600 },
    );
    child = spawn(
      python,
      [
        "-I",
        fileURLToPath(new URL("../experiments/work-journey/ts_command_host.py", import.meta.url)),
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: allowlistedEnvironment(["PATH", "HOME", "TMPDIR"]) },
    );
    let stderr = "";
    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > 65536) child!.kill();
    });
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const line = async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          lines.next(),
          new Promise<never>((_r, reject) => {
            timer = setTimeout(
              () => reject(new Error("Command Host fixture did not respond")),
              10000,
            );
          }),
        ]);
        assert(!result.done, "Command Host fixture closed: " + stderr);
        return JSON.parse(result.value);
      } finally {
        clearTimeout(timer);
      }
    };
    child.stdin!.write(
      JSON.stringify({ directory, route, timing, controlPublic, enforcerPrivate }) + "\n",
    );
    let started = await line();
    const state = async () => {
      child!.stdin!.write(JSON.stringify({ operation: "state" }) + "\n");
      return (await line()) as { calls: string[]; error: string | null };
    };
    return {
      configPath,
      close,
      async exercise(origin: string, token: string, modelConnectionId: string) {
        const api = async (
          path: string,
          method = "GET",
          body?: unknown,
          expectedStatus?: number,
        ) => {
          const response = await fetch(origin + path, {
            method,
            headers: {
              Origin: origin,
              Cookie: "openbot_session=" + token,
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(10000),
          });
          assert(
            expectedStatus === undefined ? response.ok : response.status === expectedStatus,
            `${method} ${path}: ${response.status} ${await response.clone().text()}`,
          );
          return response.status === 204 ? null : await response.json();
        };
        const enrolled = nodeEnrollmentTokenResponseSchema.parse(
          await api("/api/v1/nodes/enrollment-tokens", "POST", { nodeId: route.nodeId }),
        );
        let credential: Awaited<ReturnType<NodeCredentialStore["load"]>>;
        let relayClosed = false;
        const logger: OpenBotLogger = {
          debug() {},
          info() {},
          warn(event) {
            if (event === "node.command_relay_closed" || event === "node.connection_failed")
              relayClosed = true;
          },
          error() {
            relayClosed = true;
          },
          child: () => logger,
        };
        const connect = async () => {
          relayClosed = false;
          node = new OpenBotNodeClient(
            nodeEnvSchema.parse({
              OPENBOT_NODE_ID: route.nodeId,
              OPENBOT_NODE_SERVER_URL: origin.replace("http:", "ws:") + "/ws/nodes",
              OPENBOT_NODE_ENROLLMENT_TOKEN: enrolled.token,
              OPENBOT_NODE_MAX_CONCURRENT_RUNS: 1,
              OPENBOT_LOG_LEVEL: "error",
            }),
            [],
            {
              load: async () => credential,
              save: async (value) => {
                credential = value;
              },
            },
            logger,
            unixCommandInstallation(started.socketPath, route),
          );
          await node.start();
          const connectedUntil = Date.now() + 10000;
          while (
            !z
              .object({ nodes: z.array(z.object({ id: z.string() })) })
              .parse(await api("/api/v1/nodes"))
              .nodes.some((n: { id: string }) => n.id === route.nodeId)
          ) {
            assert(
              Date.now() < connectedUntil && !relayClosed,
              "Command Node connection unavailable",
            );
            await delay(100);
          }
        };
        await connect();
        const bot = z.object({ bot: z.object({ id: z.string().uuid() }) }).parse(
          await api("/api/v1/bots", "POST", {
            name: "Command Task fixture",
            role: "Synthetic command acceptance",
            computerProfile: "docker-linux",
            model: { connectionId: modelConnectionId, modelId: "synthetic-model" },
          }),
        ).bot;
        const channel = z.object({ channel: z.object({ id: z.string().uuid() }) }).parse(
          await api("/api/v1/channels", "POST", {
            name: "Command Task qualification",
            botIds: [bot.id],
          }),
        ).channel;
        const upload = await fetch(`${origin}/api/v1/channels/${channel.id}/attachments`, {
          method: "POST",
          headers: {
            Origin: origin,
            Cookie: "openbot_session=" + token,
            "Content-Type": "application/octet-stream",
            "X-OpenBot-Filename": "evidence.csv",
          },
          body: commandCsv,
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(upload.status, 201, await upload.clone().text());
        const attachment = z
          .object({ attachment: z.object({ id: z.string().uuid() }) })
          .parse(await upload.json()).attachment;
        const submit = async (label: string) => {
          const source = await api(`/api/v1/channels/${channel.id}/messages`, "POST", {
            botId: bot.id,
            content: `Command Task ${label}. Copy the original CSV to result.csv and review it. [OpenBot attachment: ${attachment.id}]`,
          });
          const id = z.object({ run: z.object({ workTaskId: z.string() }) }).parse(source)
            .run.workTaskId;
          const snapshot = async () =>
            workSnapshotWireSchema.parse(await api("/api/v1/tasks/" + id));
          const wait = async (predicate: (v: Awaited<ReturnType<typeof snapshot>>) => boolean) => {
            const end = Date.now() + 75000;
            while (true) {
              const value = await snapshot();
              if (predicate(value)) return value;
              assert(!["failed", "cancelled"].includes(value.status), JSON.stringify(value));
              assert(
                Date.now() < end,
                JSON.stringify({ task: value, host: await state(), relayClosed }),
              );
              await delay(150);
            }
          };
          const proposed = await wait((v) =>
              v.actions.some((a) => a.intent.tool === "run_command" && a.decision === "pending"),
            ),
            action = proposed.actions.find((a) => a.intent.tool === "run_command")!;
          assert.deepEqual(action.intent.arguments, commandArguments);
          assert.equal(action.status, "proposed");
          assert.deepEqual((await state()).calls, []);
          assert.equal(proposed.artifacts.length, 0);
          return { id, snapshot, wait, action };
        };
        const denied = await submit("denied");
        await api(`/api/v1/actions/${denied.action.id}/decision`, "POST", {
          intentDigest: denied.action.intentDigest,
          approved: false,
        });
        await denied.wait((v) => v.status === "failed");
        assert.deepEqual((await state()).calls, []);
        assert.equal((await denied.snapshot()).artifacts.length, 0);
        const { id, snapshot, wait, action } = await submit("complete");
        await api(`/api/v1/actions/${action.id}/decision`, "POST", {
          intentDigest: action.intentDigest,
          approved: true,
        });
        const completed = await wait((v) => v.status === "completed");
        assert.equal(completed.actions.find((a) => a.id === action.id)?.status, "applied");
        const output = completed.artifacts.find((a) => a.name === "result.csv");
        assert(output);
        const download = await fetch(origin + output.downloadUrl, {
          headers: { Cookie: "openbot_session=" + token },
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(download.status, 200);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), commandCsv);
        const calls = await state();
        assert.equal(calls.calls.filter((v) => v === "execute").length, 1);
        assert.equal(calls.calls.filter((v) => v === "reserve").length, 1);
        assert.equal(calls.error, null);
        assert.deepEqual(
          await api(
            `/api/v1/actions/${action.id}/decision`,
            "POST",
            {
              intentDigest: action.intentDigest,
              approved: true,
            },
            409,
          ),
          { error: "collaboration_ancestor_closed" },
        );
        assert.equal((await state()).calls.filter((v) => v === "execute").length, 1);
        console.log(
          "PASS TS command: actual Owner HTTP/approval/PG/Temporal/Node/WS/Unix/protected-Host signatures, one original permit, exact output downloaded after independent review; native isolation and peer identity are synthetic",
        );
        await node!.stop();
        child!.stdin!.write(JSON.stringify({ operation: "reset", lost: true }) + "\n");
        started = await line();
        await connect();
        const lost = await submit("lost reply");
        await api(`/api/v1/actions/${lost.action.id}/decision`, "POST", {
          intentDigest: lost.action.intentDigest,
          approved: true,
        });
        const unknown = await lost.wait((v) =>
          v.actions.some((a) => a.id === lost.action.id && a.status === "unknown"),
        );
        assert.equal(unknown.artifacts.length, 0);
        const lostCalls = await state();
        assert.equal(lostCalls.calls.filter((v) => v === "execute").length, 1);
        assert.equal(lostCalls.calls.filter((v) => v === "reserve").length, 1);
        assert.equal(lostCalls.error, "EOFError");
        await node!.stop();
        child!.stdin!.write(JSON.stringify({ operation: "reset", lost: false }) + "\n");
        started = await line();
        await connect();
        await api(`/api/v1/actions/${lost.action.id}/reconcile`, "POST", {
          intentDigest: lost.action.intentDigest,
          requestKey: randomUUID(),
          expectedSequence: 0,
          reason: "Lookup the original command receipt after connection replacement",
        });
        const reconciled = await lost.wait((v) =>
          v.actions.some(
            (a) => a.id === lost.action.id && a.reconciliation?.outcome === "unresolved",
          ),
        );
        assert.equal(reconciled.actions.find((a) => a.id === lost.action.id)?.status, "unknown");
        assert.equal(reconciled.artifacts.length, 0);
        assert.deepEqual((await state()).calls, []);
        assert.equal((await snapshot()).status, "completed");
        console.log(
          "PASS command rejection has no Host effect; actual Unix reply loss after one execution remains unknown across Node reconnection and Owner reconciliation without a second preparation or permit",
        );
        return {
          taskId: id,
          actionId: action.id,
          lostTaskId: lost.id,
          lostActionId: lost.action.id,
          deniedTaskId: denied.id,
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
