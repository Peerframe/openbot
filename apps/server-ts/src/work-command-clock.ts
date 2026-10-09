import { randomUUID } from "node:crypto";
import { WorkConflict } from "@openbot/work";
import { commandTimeLower, commandTimeUpper, type TimingPolicy } from "./work-command-contract.js";

/** Process-local elapsed intervals. SQL can retain an observation but cannot recreate its clock. */
export class CommandPrepareClock {
  readonly instanceId = randomUUID();
  private readonly pending = new Map<string, readonly [number, number, number]>();
  private origin: readonly [number, number];
  private broken = false;
  constructor(
    private readonly maxStepMs = 100,
    private readonly sample: () => readonly [number, number] = () => [
      Date.now(),
      Math.floor(performance.now()),
    ],
  ) {
    if (!Number.isSafeInteger(maxStepMs) || maxStepMs < 1 || maxStepMs > 1000)
      throw new Error("invalid_command_clock");
    this.origin = sample();
    if (!this.origin.every(Number.isSafeInteger)) throw new Error("invalid_command_clock");
  }
  healthy() {
    const [wall, mono] = this.sample(),
      [oldWall, oldMono] = this.origin;
    if (
      !Number.isSafeInteger(wall) ||
      !Number.isSafeInteger(mono) ||
      mono < oldMono ||
      Math.abs(wall - oldWall - (mono - oldMono)) >
        this.maxStepMs + Math.floor(Math.max(0, mono - oldMono) / 1000)
    )
      this.broken = true;
    if (!this.broken) this.origin = [wall, mono];
    return !this.broken;
  }
  begin(id: string, dbWall: number) {
    if (!this.healthy() || this.pending.has(id) || !Number.isSafeInteger(dbWall))
      throw new WorkConflict("command_clock_changed");
    const [wall, mono] = this.sample();
    this.pending.set(id, [dbWall, wall, mono]);
  }
  check(id: string, dbWall: number, policy: TimingPolicy, preparation = true) {
    if (!this.healthy() || !Number.isSafeInteger(dbWall)) return false;
    const original = this.pending.get(id);
    if (!original) return false;
    const [db, wall, mono] = original,
      [cw, cm] = this.sample(),
      elapsed = cm - mono;
    if (!Number.isSafeInteger(elapsed) || elapsed < 0) return false;
    return (
      (!preparation ||
        (elapsed <= policy.prepareBudgetMs && dbWall - db <= policy.prepareBudgetMs)) &&
      commandTimeLower(policy, elapsed) <= dbWall - db &&
      dbWall - db <= commandTimeUpper(policy, elapsed) &&
      commandTimeLower(policy, elapsed) <= cw - wall &&
      cw - wall <= commandTimeUpper(policy, elapsed)
    );
  }
  forget(id: string) {
    this.pending.delete(id);
  }
}
