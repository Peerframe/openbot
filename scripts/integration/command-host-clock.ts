/** Test-only causal clock port of the retained protected Host exchange. Never a product Host. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  commandTimeLower, commandTimeUpper, validateCommandTime,
  type CommandClaims, type TimingPolicy,
} from "../../apps/server/dist/work-command-contract.js";
export type ClockSample = readonly [number, number, string];
export class HostClock {
  readonly instanceId = randomUUID();
  readonly requestId: string;
  readonly nonce = randomBytes(32).toString("base64url");
  readonly start: ClockSample;
  private anchor?: { wall: number; received: ClockSample };
  private consumed = false;
  readonly policy: TimingPolicy;
  readonly clock: () => ClockSample;
  constructor(policy: TimingPolicy, clock: () => ClockSample, requestId?: string, origin?: ClockSample) {
    this.policy = policy; this.clock = clock;
    this.requestId = requestId ?? randomUUID();
    this.start = origin ?? this.sample();
    this.live();
  }
  private sample() {
    const v = this.clock();
    assert(v.slice(0, 2).every((n) => Number.isSafeInteger(n) && Number(n) > 0));
    assert(v[1] >= v[0]);
    assert.match(v[2], /^[0-9a-f-]{36}$/);
    return v;
  }
  live() {
    const now = this.sample();
    assert.equal(now[2], this.start[2], "boot changed");
    assert(now[0] >= this.start[0] && now[1] >= this.start[1], "clock regressed");
    assert(Math.abs(now[1] - now[0] - (this.start[1] - this.start[0])) <= this.policy.clockQuantizationMs * 1000, "clock suspended");
    return now;
  }
  accept(wall: number, challenge = false) {
    assert(!this.consumed, "response replayed");
    assert(Number.isSafeInteger(wall) && wall > 0);
    const received = this.live();
    if (challenge) assert(received[1] - this.start[1] < this.policy.challengeBudgetMs * 1000, "challenge expired");
    this.anchor = { wall, received };
    this.consumed = true;
  }
  interval() {
    assert(this.anchor, "no verified causal anchor");
    const now = this.live();
    return {
      lower: this.anchor.wall + commandTimeLower(this.policy, Math.floor((now[1] - this.anchor.received[1]) / 1000)),
      upper: this.anchor.wall + commandTimeUpper(this.policy, Math.ceil((now[1] - this.start[1]) / 1000)),
    };
  }
  check(value: CommandClaims) {
    const { lower, upper } = this.interval();
    validateCommandTime(value, lower);
    validateCommandTime(value, upper);
    return lower;
  }
}
