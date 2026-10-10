/** Actual TS Server/Node/Chromium browser journey; synthetic model/page, real approvals and recovery. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { workSnapshotWireSchema } from "../../packages/protocol/dist/index.js";
import {
  BrowserProductFixture,
  BrowserHttpFailure,
  ROOT,
  jsonFile,
  nestedId,
  privateJson,
  record,
} from "./browser-product-fixture.ts";
import { verifyBrowserUpstream } from "./product-browser-upstream.ts";

const TEXT = "浏览器任务 你好 🌏";
const modeSchema = z.enum([
  "pages",
  "worker",
  "control",
  "node",
  "replacement",
  "response-loss",
  "browser-restart",
  "linux-replacement",
]);
export type BrowserRecovery = z.infer<typeof modeSchema>;
const loopback = z.url().refine((value) => {
  const u = new URL(value);
  return (
    u.protocol === "http:" &&
    u.hostname === "127.0.0.1" &&
    !!u.port &&
    !u.username &&
    !u.password &&
    u.pathname === "/" &&
    !u.search &&
    !u.hash
  );
});
export const remoteBrowserConfiguration = z
  .object({
    fixtureEnvironment: z.literal("disposable-github-linux"),
    computerUrl: loopback,
    stateUrl: loopback,
    targetUrl: z.literal("https://example.com:18443"),
    token: z.literal("synthetic-linux-composition-fixture-only"),
  })
  .strict();
const emit = (value: unknown) => console.log(JSON.stringify(value));
const present = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
export async function qualifyBrowser(options: {
  directory: string;
  upstream: string;
  browsers: string;
  recovery: BrowserRecovery;
  remote?: unknown;
}) {
  process.umask(0o077);
  const directory = resolve(options.directory),
    recovery = modeSchema.parse(options.recovery);
  const remote =
    options.remote === undefined ? undefined : remoteBrowserConfiguration.parse(options.remote);
  assert.equal(recovery === "linux-replacement", !!remote);
  const connectionRecovery = ["control", "node", "replacement"].includes(recovery),
    profileRecovery = ["browser-restart", "linux-replacement"].includes(recovery);
  const pauseWorker =
    recovery !== "pages" && recovery !== "response-loss" && recovery !== "linux-replacement";
  await verifyBrowserUpstream(options.upstream);
  assert(!(await present(directory)), "Use a new owned output directory");
  const fixture = new BrowserProductFixture(
    directory,
    AbortSignal.timeout(360000),
    remote ? 20000 : 5000,
  );
  if (!remote)
    await promisify(execFile)(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');const {registry}=require(process.argv[1]+'/node_modules/playwright-core/lib/coreBundle.js');const p=registry.registry.findExecutable('chromium-headless-shell').executablePath();if(!p||!fs.existsSync(p))throw Error('Pinned Chromium headless shell required');",
        options.upstream,
      ],
      {
        cwd: ROOT,
        env: { ...fixture.environment, PLAYWRIGHT_BROWSERS_PATH: options.browsers },
        timeout: 10000,
        maxBuffer: 32768,
      },
    );
  let result: Record<string, unknown> | undefined,
    failure: unknown,
    initialized = false;
  try {
    await fixture.initialize();
    initialized = true;
    emit({ stage: "engine-ready" });
    const api = fixture.api.bind(fixture),
      until = fixture.until.bind(fixture);
    const connectionId = nestedId(
      await api(
        "/api/v1/model-connections",
        {
          name: "Synthetic browser model",
          presetId: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "synthetic-browser-key",
        },
        201,
      ),
      "connection",
    );
    const botId = nestedId(
      await api(
        "/api/v1/bots",
        {
          name: "Browser product fixture",
          role: "Synthetic page reader",
          computerProfile: "docker-linux",
          model: { connectionId, modelId: "synthetic-browser-model" },
        },
        201,
      ),
      "bot",
    );
    const channelId = nestedId(
      await api("/api/v1/channels", { name: "Browser qualification", botIds: [botId] }, 201),
      "channel",
    );
    const nodeId = "browser-product-" + randomBytes(5).toString("hex");
    const enroll = async () => {
      const { token } = z
        .object({ token: z.string() })
        .parse(await api("/api/v1/nodes/enrollment-tokens", { nodeId }, 201));
      return z
        .object({ credential: z.string() })
        .parse(await api("/api/v1/nodes/enroll", { nodeId, token }, 201)).credential;
    };
    const target = await fixture.startNode(
      "experiments/work-journey/" +
        (remote ? "product_browser_native_node.ts" : "product_browser_node.ts"),
      {
        nodeId,
        botId,
        serverUrl: fixture.origin.replace("http:", "ws:") + "/ws/nodes",
        credential: await enroll(),
        directory: join(directory, "node"),
        upstream: options.upstream,
        recovery: connectionRecovery || profileRecovery,
        nodeProcess: ["node", "replacement"].includes(recovery),
        responseLoss: recovery === "response-loss",
        profileRestart: profileRecovery,
        remote,
      },
      options.browsers,
    );
    const stateTarget = remote?.stateUrl.replace(/\/$/, "") ?? target;
    const state = async () =>
      record.parse(
        await (
          await fetch(stateTarget + "/state", {
            redirect: "error",
            signal: AbortSignal.any([fixture.signal, AbortSignal.timeout(5000)]),
          })
        ).json(),
      );
    const browserPath = join(directory, "browser.json");
    await privateJson(browserPath, {
      version: 1,
      humanControl: true,
      routes: { [botId]: nodeId },
      pageOrigins: { [botId]: [target] },
    });
    await privateJson(join(directory, "provider.json"), {
      directory: join(directory, "provider"),
      target,
    });
    fixture.environmentForServer.OPENBOT_CONTROL_BROWSER_CONFIG_PATH = browserPath;
    const connected = async () =>
      z
        .object({ nodes: z.array(z.object({ id: z.string() })) })
        .parse(await api("/api/v1/nodes"))
        .nodes.some((n) => n.id === nodeId);
    const restartControl = async () => {
      await fixture.restart();
      await until(connected);
    };
    let controlId = 0;
    const nodeControl = async (operation: string, credential?: string) => {
      controlId++;
      const staged = join(directory, "node/control-request.next");
      await privateJson(staged, {
        id: controlId,
        operation,
        ...(credential ? { credential } : {}),
      });
      await rename(staged, join(directory, "node/control-request.json"));
      await until(
        () => present(join(directory, `node/control-${controlId}.json`)),
        remote ? 60 : 20,
      );
      if (operation === "connect" || operation === "disconnect")
        await until(async () => (await connected()) === (operation === "connect"));
    };
    const interruptConnection = async () => {
      if (recovery === "control") await restartControl();
      else {
        await nodeControl("disconnect");
        let replacement: string | undefined;
        if (recovery === "replacement") {
          await api(`/api/v1/nodes/${nodeId}/revoke`, {}, 204);
          replacement = await enroll();
        }
        await nodeControl("connect", replacement);
      }
    };
    const workerMarker = async (name: string) => {
      const path = join(directory, "provider", name);
      return (
        (await present(path)) && (await readFile(path, "utf8")) === String(fixture.server?.pid)
      );
    };
    await restartControl();
    const view = z
      .object({ id: z.string() })
      .parse(await api(`/api/v1/bots/${botId}/browser`, {}, 201));
    emit({ stage: "browser-route-ready", actualNode: true });
    const source = nestedId(
      await api(
        `/api/v1/channels/${channelId}/messages`,
        {
          botId,
          content:
            "Open the configured synthetic page, fill Fixture text with 浏览器任务 你好 🌏, click Save synthetic entry once, read the resulting page, and write a report of what it displayed. Do not claim an external transaction.",
        },
        201,
      ),
      "run",
    );
    assert(fixture.database);
    const [identity] = await fixture.database
      .client`SELECT s.task_id,r.id FROM work_sources s JOIN work_runs r ON r.task_id=s.task_id WHERE s.legacy_run_id=${source}`;
    const taskId = z.string().parse(identity?.task_id),
      runId = z.string().parse(identity?.id);
    await privateJson(join(directory, "identity.json"), { taskId, runId });
    const snapshot = async () => {
      const value = await fixture.snapshot(taskId);
      if (value === false) return undefined;
      const checked = workSnapshotWireSchema.parse(value);
      await privateJson(join(directory, "snapshot.json"), checked);
      return checked;
    };
    const counts = () => jsonFile(join(directory, "node/browser-counts.json"));
    const modelCounts = () => jsonFile(join(directory, "provider/provider-counts.json"));
    const viewCommand = (id: string, body: unknown, expected = 200) =>
      api(`/api/v1/browser-sessions/${id}/commands`, body, expected);
    for (const name of ["navigate_browser", "type_browser", "click_browser", "read_browser"]) {
      const pending = async () => {
        const value = await snapshot();
        if (!value) return undefined;
        assert(!["failed", "cancelled"].includes(value.status));
        assert(
          !value.actions.some((a) => a.status === "unknown"),
          "Earlier browser operation unresolved",
        );
        return value.actions.find((a) => a.intent.tool === name && a.status === "proposed");
      };
      const action = await until(pending);
      assert.equal(action.decision, "pending");
      if (name === "click_browser") {
        if (pauseWorker) {
          await writeFile(join(directory, "provider/pause-worker"), "", { mode: 0o600 });
          await until(() => workerMarker("worker-stopped"), 30);
        }
        const value = await state();
        assert.equal(value.submitted, 0);
        assert.equal(value.text, TEXT);
        emit({
          stage: pauseWorker
            ? "worker-stopped-with-original-click-pending"
            : "original-click-pending",
        });
        if (connectionRecovery) {
          await interruptConnection();
          await until(() => workerMarker("worker-stopped"), 30);
          await viewCommand(view.id, { kind: "observe" }, 404);
          assert.equal((await until(pending)).id, action.id);
          emit({ stage: "connection-changed-before-original-approval", mode: recovery });
        }
      }
      await api(`/api/v1/actions/${action.id}/decision`, {
        intentDigest: action.intentDigest,
        approved: true,
      });
      if (name === "click_browser" && pauseWorker) {
        await delay(400);
        assert.equal((await state()).submitted, 0);
        await writeFile(join(directory, "provider/resume-worker"), "", { mode: 0o600 });
        await until(() => workerMarker("worker-resumed"), 30);
      }
      emit({ stage: "approved", tool: name });
      if (name !== "click_browser" || !(connectionRecovery || recovery === "response-loss"))
        continue;
      const denied = await until(async () => {
        const value = await snapshot(),
          row = value?.actions.find((a) => a.id === action.id);
        if (!row) return undefined;
        assert.notEqual(row.status, "applied");
        if (!connectionRecovery) return row.status === "unknown" ? row : undefined;
        if (value?.status !== "failed") return undefined;
        assert.equal(value.authorityActive, false);
        assert.equal(row.status, "proposed");
        assert.equal(row.decision, "approved");
        assert.equal(
          value.events.filter(
            (e) =>
              ["action.admitted", "tool.browser_page_started"].includes(e.kind) &&
              record.parse(e.payload).actionId === action.id,
          ).length,
          0,
        );
        const failed = value.events.find((e) => e.kind === "task.failed");
        assert(failed);
        assert.equal(
          record.parse(failed.payload).reason,
          recovery === "replacement" ? "browser_identity_changed" : "browser_connection_changed",
        );
        return row;
      });
      const browserCalls = await counts(),
        expectedCalls = {
          navigate: 1,
          type: 1,
          ...(recovery === "response-loss" ? { click: 1 } : {}),
        };
      assert.deepEqual(browserCalls, expectedCalls);
      const handle = fixture.handle(runId);
      if (connectionRecovery) {
        const before = await until(snapshot);
        assert.deepEqual(await api(`/api/v1/tasks/${taskId}/cancel`, {}, 409), {
          error: "task_closed",
        });
        assert.deepEqual(await until(snapshot), before);
        assert(fixture.engine);
        assert.equal(
          await fixture.engine.connection.withDeadline(Date.now() + 20000, () => handle.result()),
          undefined,
        );
      } else {
        const cancelled = record.parse(await api(`/api/v1/tasks/${taskId}/cancel`, {}));
        assert(cancelled.cancelRequested && !cancelled.authorityActive);
        // The live TS history preserves an uncertain effect after cancellation closes authority.
        await api(
          `/api/v1/actions/${action.id}/reconcile`,
          {
            intentDigest: action.intentDigest,
            requestKey: randomUUID(),
            expectedSequence: 0,
            reason: "Lookup the original click receipt after cancellation",
          },
          202,
        );
        await until(async () =>
          (await snapshot())?.actions.some(
            (a) => a.id === action.id && a.reconciliation?.outcome === "unresolved",
          ),
        );
      }
      const engineStatus = (await handle.describe()).status.name;
      assert.equal(engineStatus, connectionRecovery ? "COMPLETED" : "RUNNING");
      const closed = await until(snapshot);
      assert.equal(closed.cancelRequested, !connectionRecovery);
      assert.equal(closed.authorityActive, false);
      assert.equal(closed.artifacts.length, 0);
      assert.equal(closed.actions.find((a) => a.id === action.id)?.status, denied.status);
      if (recovery === "replacement")
        assert.deepEqual(await api(`/api/v1/bots/${botId}/browser`, {}, 409), {
          error: "browser_host_identity_changed",
        });
      else if (connectionRecovery) {
        const fresh = z
          .object({ id: z.string() })
          .parse(await api(`/api/v1/bots/${botId}/browser`, {}, 201));
        assert.equal(record.parse(await viewCommand(fresh.id, { kind: "take" })).control, "mine");
        await interruptConnection();
        await viewCommand(fresh.id, { kind: "observe" }, 404);
        const reopened = z
          .object({ id: z.string(), control: z.string() })
          .parse(await api(`/api/v1/bots/${botId}/browser`, {}, 201));
        assert(["other", "paused"].includes(reopened.control));
        const acquired = await until(async () => {
          try {
            return record.parse(await viewCommand(reopened.id, { kind: "take" }));
          } catch (error) {
            if (
              error instanceof BrowserHttpFailure &&
              error.status === 409 &&
              record.parse(error.payload).error === "browser_control_held_elsewhere"
            )
              return false;
            throw error;
          }
        }, 35);
        assert.equal(acquired.control, "mine");
        assert.equal(
          record.parse(await viewCommand(reopened.id, { kind: "release" })).control,
          "available",
        );
      }
      const targetState = await state(),
        expectedSubmitted = recovery === "response-loss" ? 1 : 0;
      assert.equal(targetState.submitted, expectedSubmitted);
      assert.equal(targetState.text, TEXT);
      const modelCalls = await modelCounts();
      assert.deepEqual(modelCalls, { navigate: 1, type: 1, click: 1 });
      await fixture.replay(runId);
      assert.deepEqual(await counts(), browserCalls);
      assert.deepEqual(await modelCounts(), modelCalls);
      result = {
        accepted: true,
        entry: "ts",
        readUnavailablePolls: fixture.unavailableReads,
        mode: recovery,
        scope: "trusted synthetic page on local Chromium",
        actualProductEntry: true,
        actualNode: true,
        actualChromium: true,
        actualPostgres: true,
        mutualTLS: true,
        canonicalMigrations: fixture.migrations,
        actualWorkApprovals: 3,
        modelHTTP: "synthetic",
        browserCalls,
        modelCalls,
        originalClickStatus: denied.status,
        actualTargetSubmitted: expectedSubmitted,
        cancelRequested: closed.cancelRequested,
        authorityActive: false,
        unresolvedActionPreserved: !connectionRecovery,
        taskStatus: closed.status,
        offlineReplay: true,
        publicEgressQualified: false,
        isolatedLinuxBrowserProduct: false,
        engineStatus,
        historyReplayScope: connectionRecovery ? "closed-workflow" : "open-workflow",
        ...(connectionRecovery
          ? { staleClickNeverAdmitted: true, alreadyClosedCancellationRefused: true }
          : { cancelledUnknownReconciliation: "unresolved" }),
        wholeControlProcessRestarted: recovery === "control",
        nodeProcessRestarted: ["node", "replacement"].includes(recovery),
        browserProcessRestarted: false,
      };
      if (connectionRecovery)
        Object.assign(result, { staleApprovalNeverDispatched: true, oldViewRefused: true });
      if (recovery === "response-loss") {
        assert.deepEqual(await jsonFile(join(directory, "node/response-loss.json")), {
          upstreamClickRequests: 1,
          upstreamSuccess: true,
          targetSubmitted: 1,
        });
        assert.equal(denied.status, "unknown");
        Object.assign(result, {
          actualResponseSocketDestroyed: true,
          clickAppliedButUnknown: true,
          originalClickNeverRetried: true,
        });
      }
      if (["node", "replacement"].includes(recovery)) {
        const events = z
          .array(
            z.object({
              pid: z.number(),
              event: z.string(),
              signal: z.string().nullable().optional(),
            }),
          )
          .parse(await jsonFile(join(directory, "node/node-processes.json")));
        const starts = events.filter((p) => p.event === "start").map((p) => p.pid),
          exits = events.filter((p) => p.event === "exit" && p.signal === "SIGKILL");
        assert.equal(starts.length, recovery === "node" ? 3 : 2);
        assert.equal(new Set(starts).size, starts.length);
        assert.equal(exits.length, starts.length - 1);
        Object.assign(result, {
          distinctNodeProcesses: starts.length,
          abruptNodeExits: exits.length,
        });
      }
      if (recovery === "replacement") result.sameIdNewCredentialRefused = true;
      else if (connectionRecovery)
        Object.assign(result, {
          humanPauseSurvived: true,
          explicitReacquisitionAndReturn: true,
          originalBrowserStateRetained: true,
        });
      return;
    }
    const completed = await until(async () => {
      const value = await snapshot();
      if (!value) return undefined;
      assert(!["failed", "cancelled"].includes(value.status));
      return value.status === "completed" ? value : undefined;
    });
    const browserCalls = await counts(),
      modelCalls = await modelCounts();
    assert.deepEqual(browserCalls, { navigate: 1, type: 1, click: 1, read: 1 });
    assert.deepEqual(modelCalls, {
      navigate: 1,
      type: 1,
      click: 1,
      read: 1,
      report: 1,
      final: 1,
      review: 1,
    });
    assert.equal(completed.artifacts.length, 1);
    const artifact = completed.artifacts[0];
    assert(artifact);
    const report = await api(artifact.downloadUrl, undefined, 200, true);
    assert(Buffer.isBuffer(report) && report.toString().includes("Saved: " + TEXT));
    const targetState = await state();
    assert.equal(targetState.submitted, 1);
    assert.equal(targetState.stored, TEXT);
    const handle = fixture.handle(runId);
    assert(fixture.engine);
    assert.equal(
      await fixture.engine.connection.withDeadline(Date.now() + 20000, () => handle.result()),
      undefined,
    );
    assert.equal((await handle.describe()).status.name, "COMPLETED");
    await fixture.replay(runId);
    assert.deepEqual(await counts(), browserCalls);
    assert.deepEqual(await modelCounts(), modelCalls);
    result = {
      accepted: true,
      entry: "ts",
      readUnavailablePolls: fixture.unavailableReads,
      scope: "trusted synthetic page on local Chromium",
      actualProductEntry: true,
      actualNode: true,
      actualChromium: true,
      actualPostgres: true,
      mutualTLS: true,
      canonicalMigrations: fixture.migrations,
      actualWorkApprovals: 4,
      modelHTTP: "synthetic",
      browserCalls,
      modelCalls,
      approvedWhileWorkerStopped: pauseWorker,
      sameNodeConnectionRetained: true,
      originalClickOnlyOnce: true,
      actualTargetIndependentState: true,
      reportDownloaded: true,
      offlineReplay: true,
      publicEgressQualified: false,
      isolatedLinuxBrowserProduct: false,
    };
    if (profileRecovery) {
      assert(targetState.persistentCookie && targetState.sessionCookie);
      assert.equal(targetState.indexedDB, "synthetic-indexed-value");
      assert.equal(record.parse(await viewCommand(view.id, { kind: "take" })).control, "mine");
      await nodeControl("browser-restart");
      assert.equal(record.parse(await viewCommand(view.id, { kind: "observe" })).control, "mine");
      await viewCommand(view.id, { kind: "navigate", url: target + "/" });
      const restored = await until(async () => {
        const value = await state();
        return value.indexedDB === "synthetic-indexed-value" ? value : undefined;
      }, 4);
      assert.equal(restored.stored, TEXT);
      assert.equal(restored.text, TEXT);
      assert.equal(restored.persistentCookie, true);
      assert.equal(restored.sessionCookie, false);
      await nodeControl("browser-readback");
      const processes = record.parse(
        await jsonFile(join(directory, "node/browser-processes.json")),
      );
      if (remote)
        assert.deepEqual(processes, {
          oldContainerExited: true,
          oldExitCode: 0,
          newContainer: true,
          samePrivateProfile: true,
        });
      else {
        assert(processes.oldBrowserExited);
        assert.notEqual(processes.oldBrowser, processes.newBrowser);
        assert.notEqual(processes.oldService, processes.newService);
      }
      assert.equal(
        record.parse(await viewCommand(view.id, { kind: "release" })).control,
        "available",
      );
      assert.deepEqual(await counts(), browserCalls);
      assert.deepEqual(await modelCounts(), modelCalls);
      Object.assign(result, {
        mode: recovery,
        browserProcessRestarted: true,
        browserServiceProcessRestarted: true,
        originalBrowserExitedBeforeReplacement: true,
        samePrivateProfileReused: true,
        localStorageRetained: true,
        expiringCookieRetained: true,
        sessionCookieDropped: true,
        indexedDBRetained: true,
        humanPauseSurvived: true,
        explicitReturnRequired: true,
        agentCallsUnchangedAfterBrowserRestart: true,
      });
    }
    if (remote)
      Object.assign(result, {
        scope:
          "synthetic page on isolated Linux Chromium through Squid and native packet enforcement",
        isolatedLinuxBrowserProduct: true,
        actualContainerReplacement: true,
        remoteNativeCleanupPending: true,
      });
  } catch (error) {
    failure = error;
    if (result) result.accepted = false;
    if (initialized)
      await privateJson(join(directory, "failure-private.json"), {
        error: error instanceof Error ? error.stack : "Browser qualification failed",
      });
    throw error;
  } finally {
    await finishFixture(fixture, result, failure);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      upstream: { type: "string" },
      browsers: { type: "string" },
      recovery: { type: "string", default: "worker" },
      "remote-host-config": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  assert(values.output && values.upstream && values.browsers);
  await qualifyBrowser({
    directory: resolve(values.output),
    upstream: resolve(values.upstream),
    browsers: resolve(values.browsers),
    recovery: modeSchema.parse(values.recovery),
    ...(values["remote-host-config"]
      ? { remote: await jsonFile(values["remote-host-config"]) }
      : {}),
  });
}

async function finishFixture(
  fixture: BrowserProductFixture,
  result: Record<string, unknown> | undefined,
  failure: unknown,
) {
  const save = async () => {
    if (result) {
      await privateJson(join(fixture.directory, "RESULT.json"), result);
      emit(result);
    }
  };
  try {
    await fixture.close();
  } catch (error) {
    if (result) {
      result.accepted = false;
      result.ownedFixturesClosed = false;
    }
    await save();
    throw new AggregateError(
      failure ? [failure, error] : [error],
      "Browser qualification cleanup failed",
    );
  }
  if (result) result.ownedFixturesClosed = true;
  await save();
}
