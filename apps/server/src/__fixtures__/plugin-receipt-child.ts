import { dirname } from "node:path";
import type { Run } from "@openbot/domain";
import { PluginService } from "../plugin-service.js";
import { FilePluginStore } from "../plugin-store.js";

const [mode, path, endpoint] = process.argv.slice(2);
if (!path || !endpoint || (mode !== "call" && mode !== "inspect"))
  throw new Error("Invalid synthetic receipt child configuration.");
const store = new FilePluginStore(path, {
  // ACL behavior has separate native conformance tests; this child tests process lifecycle only.
  windowsTrustRoot: dirname(dirname(path)),
  windowsAcl: {
    protectDirectory: async () => {},
    verifyDirectory: async () => {},
    protectAndVerifyFile: async () => {},
    verifyFile: async () => {},
  },
});
const run = { id: "crash-run", botId: "crash-bot", channelId: "crash-channel" } as Run;
const service = new PluginService({
  store,
  localEndpoints: [endpoint],
  assertScope: async () => {},
  botExists: async () => true,
  runExists: async (id) => id === run.id,
});
await service.recover();
if (mode === "inspect") {
  const calls = await service.receiptsForRun(run.id);
  let repeatRejected = false;
  if (calls[0]) {
    try {
      await service.decide(calls[0].id, "approve");
    } catch {
      repeatRejected = true;
    }
  }
  process.send?.({ type: "recovered", calls, repeatRejected });
  process.disconnect?.();
} else {
  const plugin = (await service.snapshot()).plugins[0];
  if (!plugin) throw new Error("Synthetic plugin not installed.");
  process.on("message", (message) => {
    if (typeof message !== "object" || message === null || !("id" in message)) return;
    void service.decide(String(message.id), "approve").then(
      () => process.send?.({ type: "approved", id: message.id }),
      () => process.send?.({ type: "decision_failed" }),
    );
  });
  void service
    .call(
      run,
      {
        pluginId: plugin.id,
        revision: plugin.revision,
        toolName: "increment",
        arguments: {},
      },
      AbortSignal.timeout(20_000),
    )
    .then(
      () => process.send?.({ type: "completed" }),
      () => process.send?.({ type: "call_failed" }),
    );
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const pending = (await service.snapshot()).pendingCalls[0];
    if (pending) {
      process.send?.({ type: "pending", id: pending.id });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
