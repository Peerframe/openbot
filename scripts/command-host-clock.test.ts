/** Causal time cannot be supplied by an unsigned wire response or survive boot/suspend/replay. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { HostClock, type ClockSample } from "./integration/command-host-clock.ts";
const timing = { prepareBudgetMs: 30000, challengeBudgetMs: 5000, runtimeMaxMs: 50000, stopAllowanceMs: 5000, clockRateErrorPpm: 1000, clockQuantizationMs: 100, policyDigest: "e".repeat(64) };
test("causal intervals require a response, reject replay and conservatively bound elapsed time", () => {
  let sample: ClockSample = [1000000, 1000000, randomUUID()];
  const c = new HostClock(timing, () => sample);
  assert.throws(() => c.interval(), /no verified/);
  sample = [1100000, 1100000, sample[2]]; c.accept(100000, true);
  sample = [1300000, 1300000, sample[2]];
  const value = c.interval(); assert(value.lower <= 100200 && value.upper >= 100300);
  assert.throws(() => c.accept(100300), /replayed/);
});
for (const mode of ["boot", "suspend", "regression", "expiry"] as const) test(`reject ${mode}`, () => {
  let sample: ClockSample = [1000000, 1000000, randomUUID()];
  const c = new HostClock(timing, () => sample);
  if (mode === "boot") sample = [1100000, 1100000, randomUUID()];
  if (mode === "suspend") sample = [1100000, 2200000, sample[2]];
  if (mode === "regression") sample = [999999, 1000000, sample[2]];
  if (mode === "expiry") sample = [6000000, 6000000, sample[2]];
  assert.throws(() => c.accept(100000, true));
});
