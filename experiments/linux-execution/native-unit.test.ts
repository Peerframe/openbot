/** Unit/readback and expiry counterexamples; synthetic commands do not qualify systemd/runsc. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  durationUs,
  validateUnit,
  stopHooks,
  unitName,
  NativeCommandFailure,
} from "./native-unit.ts";
import { guardLifecycle } from "./native-runtime.ts";
import { DockerCli } from "./docker-cli.ts";
import type { CommandResult } from "./subprocess.ts";
const unit = "openbot-command-" + "a".repeat(32) + ".service";
const facts = () => ({
  Type: "exec",
  KillMode: "control-group",
  KillSignal: "9",
  FinalKillSignal: "9",
  SendSIGKILL: "yes",
  Restart: "no",
  NRestarts: "0",
  NotifyAccess: "none",
  ExecStop: "",
  ExecStopPost: "",
  TriggeredBy: "",
  PrivateNetwork: "yes",
  PrivateMounts: "yes",
  DelegateSubgroup: "supervisor",
  MemoryMax: String(2500 * 1024 ** 2),
  MemorySwapMax: "0",
  TasksMax: "1536",
  ControlGroup: "/system.slice/" + unit,
  ActiveState: "active",
  RuntimeMaxUSec: "50s",
  RuntimeRandomizedExtraUSec: "0",
  TimeoutStopUSec: "1s",
  CPUQuotaPerSecUSec: "1.500000s",
  InvocationID: "b".repeat(32),
  MainPID: "1234",
  ActiveEnterTimestampMonotonic: "1000000",
});
test("fixed original unit and exact duration readback", () => {
  assert.equal(validateUnit(facts(), unit, 50000), 1000000);
  assert.equal(durationUs("1min 2s 3ms 4us"), 62003004);
  assert.equal(durationUs("0.000001s"), 1);
  assert.equal(durationUs("0"), 0);
});
for (const value of [
  "infinity",
  "-1s",
  "NaNs",
  "1e3s",
  ".1s",
  "1.0000001s",
  "1.5us",
  "9007199254740992us",
  "1s garbage",
  "",
  "1m",
  "1s\n",
])
  test("rejects nonfinite/ambiguous duration " + JSON.stringify(value), () =>
    assert.throws(() => durationUs(value)),
  );
for (const key of Object.keys(facts()))
  test("changed or missing unit fact refuses: " + key, () => {
    const value: Record<string, string> = facts();
    value[key] = "changed";
    assert.throws(() => validateUnit(value, unit, 50000));
    delete value[key];
    assert.throws(() => validateUnit(value, unit, 50000));
  });
for (const value of ["foreign.service", unit + "\n", "../" + unit, "--all", unit.replace("a", "g")])
  test("only original bounded unit names: " + JSON.stringify(value), () =>
    assert.throws(() => unitName(value)),
  );
test("typed stop hooks must be present and exactly empty", async () => {
  let count = 0;
  const found = JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/original"] }),
    empty = JSON.stringify({ type: "a(sasbttttuii)", data: [] });
  assert.deepEqual(
    await stopHooks(unit, async () => (++count === 1 ? found : empty + "\n" + empty)),
    { ExecStop: "", ExecStopPost: "" },
  );
  assert.equal(count, 2);
  for (const data of [
    "",
    empty,
    empty + "\n" + empty + "\n" + empty,
    empty + "\n" + JSON.stringify({ type: "a(sasbttttuii)", data: ["hook"] }),
    empty + "\n" + JSON.stringify({ type: "s", data: [] }),
  ]) {
    let n = 0;
    await assert.rejects(() => stopHooks(unit, async () => (++n === 1 ? found : data)));
  }
  for (const data of [
    { type: "o", data: ["/etc/passwd"] },
    { type: "s", data: ["/org/freedesktop/systemd1/unit/original"] },
    { type: "o", data: [] },
  ])
    await assert.rejects(() => stopHooks(unit, async () => JSON.stringify(data)));
});
test("expiry between create and start cannot start; each verb uses remaining original time", async () => {
  const calls: { args: readonly string[]; timeout: number }[] = [];
  let now = 1000;
  const cli = new DockerCli({
    async run(args, timeout) {
      calls.push({ args, timeout });
      now = 5000000;
      return {
        argv: args,
        status: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        outputTruncated: false,
        capturedBytes: 0,
        ok: true,
        uncertain: false,
      } as CommandResult;
    },
  });
  guardLifecycle(
    cli,
    {
      bootId: "boot",
      enforcerInstanceId: "original",
      expiresBoottimeUs: 5000000,
      digest: "unused",
    },
    "unused",
    () => [now, now, "boot"],
    () => ({ instanceId: "original" }),
  );
  await cli.create(["fixed"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.timeout, 4999);
  assert.throws(() => cli.start("original"), /native_guard_expired/);
  assert.equal(calls.length, 1);
});
for (const change of ["boot", "instance", "expired"])
  test("native launch refuses before any verb: " + change, () => {
    const cli = new DockerCli({
      run() {
        assert.fail("expired launch reached Docker");
      },
    });
    guardLifecycle(
      cli,
      { bootId: "boot", enforcerInstanceId: "original", expiresBoottimeUs: 5000, digest: "unused" },
      "unused",
      () => [1000, change === "expired" ? 5000 : 1000, change === "boot" ? "new" : "boot"],
      () => ({ instanceId: change === "instance" ? "new" : "original" }),
    );
    assert.throws(() => cli.create([]), /native_guard_expired/);
  });

test("native command diagnostics retain fixed codes while excluding arbitrary output", () => {
  const base = {
    argv: [],
    stdout: "private stdout",
    stderr: "native_guard_expired\n",
    status: 1,
    ok: false,
    uncertain: false,
    timedOut: false,
    outputTruncated: false,
    capturedBytes: 1,
  };
  const failure = new NativeCommandFailure("execute", base);
  assert.equal(failure.message, "native_command_unknown");
  assert.equal(failure.diagnostic.helperCode, "native_guard_expired");
  for (const stderr of [
    "private cookie=synthetic",
    "arbitrary_lowercase_input",
    "-----BEGIN PRIVATE KEY-----",
    "first\nsecond",
    "x".repeat(81),
  ]) {
    const redacted = new NativeCommandFailure("execute", { ...base, stderr });
    assert.equal(redacted.diagnostic.helperCode, null);
    assert(!JSON.stringify(redacted.diagnostic).includes(stderr));
    assert(!JSON.stringify(redacted.diagnostic).includes(base.stdout));
  }
});
