import { type PluginCallReceipt, pluginCallReceiptSchema } from "@openbot/protocol";
import type { PluginState } from "./plugin-store.js";
import { PluginError } from "./plugin-types.js";

export const pluginCallReceiptLimit = 256;
const activeStates = new Set(["preparing", "awaiting_approval", "dispatching"]);

export function receiptNeedsRetention(call: PluginCallReceipt): boolean {
  return activeStates.has(call.state) || call.state === "outcome_unknown";
}

export function insertCallReceipt(state: PluginState, receipt: PluginCallReceipt): void {
  state.callReceipts ??= [];
  const calls = state.callReceipts;
  if (calls.length >= pluginCallReceiptLimit) {
    // Only settled history may be evicted. Never turn missing evidence into permission to replay.
    const oldest = calls
      .filter((call) => !receiptNeedsRetention(call))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    if (!oldest)
      throw new PluginError(
        "unavailable",
        "插件调用回执已达容量上限，未决记录已保留。未派发新调用。",
      );
    calls.splice(calls.indexOf(oldest), 1);
  }
  if (calls.some((call) => call.id === receipt.id)) throw new PluginError("conflict");
  calls.push(pluginCallReceiptSchema.parse(receipt));
}

export function callReceipt(state: PluginState, id: string): PluginCallReceipt {
  const receipt = state.callReceipts?.find((call) => call.id === id);
  if (!receipt) throw new PluginError("not_found");
  return receipt;
}

export function recoverCallReceipts(
  state: PluginState,
  abandoned: (call: PluginCallReceipt) => boolean = () => true,
): void {
  const now = new Date().toISOString();
  for (const call of state.callReceipts ?? []) {
    if (!activeStates.has(call.state) || !abandoned(call)) continue;
    if (call.approvalDecision === null && call.state === "awaiting_approval") {
      call.approvalDecision = "interrupted";
      call.approvalDecidedAt = now;
    }
    call.state = call.state === "dispatching" ? "outcome_unknown" : "not_dispatched";
    call.updatedAt = now;
  }
}

export function sortedCallReceipts(calls: PluginCallReceipt[]): PluginCallReceipt[] {
  const rank = (call: PluginCallReceipt) =>
    call.state === "outcome_unknown" ? 0 : activeStates.has(call.state) ? 1 : 2;
  return calls.sort(
    (a, b) =>
      rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}
