import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertPreviousProcessEnded,
  createProcessIdentity,
  isProcessAlive,
  isProcessIdentity,
  observeProcessIdentity,
  processIdentitiesEqual,
  readLinuxProcStartTimeToken,
  type ProcessIdentity,
} from "./smoke-process-identity.ts";

afterEach(() => vi.restoreAllMocks());

const recorded: ProcessIdentity = {
  pid: process.pid,
  startTimeUtc: "recorded-token",
  executablePath: "/recorded/path",
};

it("parses Linux field 22 after a comm containing spaces and parentheses", () => {
  expect(readLinuxProcStartTimeToken("1 (x) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 99 0")).toBe(
    "linux-ticks:99",
  );
  expect(readLinuxProcStartTimeToken(`1 (worker ) name) S ${"0 ".repeat(18)}1234 0`)).toBe(
    "linux-ticks:1234",
  );
  for (const value of ["", "no closing parenthesis", "1 (x) S", `1 (x) S ${"0 ".repeat(18)}bad`]) {
    expect(readLinuxProcStartTimeToken(value)).toBeNull();
  }
});

it("observes real liveness, including a process owned by another user on Linux", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(2_147_483_647)).toBe(false);
  if (process.platform === "linux") expect(isProcessAlive(1)).toBe(true);
});

it("rejects malformed PIDs before making any native call", () => {
  const kill = vi.spyOn(process, "kill");
  for (const value of [-1, 0, 1.5, 2_147_483_648, NaN, Infinity, "1", null, undefined]) {
    expect(isProcessAlive(value)).toBe(false);
    expect(isProcessIdentity({ ...recorded, pid: value })).toBe(false);
  }
  expect(kill).not.toHaveBeenCalled();
  expect(isProcessIdentity(null)).toBe(false);
  expect(isProcessIdentity({ pid: 1 })).toBe(false);
  expect(isProcessIdentity({ ...recorded, executablePath: 42 })).toBe(false);
  expect(() => createProcessIdentity({ pid: -1 })).toThrow(/incomplete/);
});

it("only treats ESRCH as exited; EPERM is alive and unexpected failures propagate", () => {
  const kill = vi.spyOn(process, "kill");
  kill.mockImplementation(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  expect(isProcessAlive(process.pid)).toBe(false);
  kill.mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  expect(isProcessAlive(process.pid)).toBe(true);
  const failure = Object.assign(new Error("unexpected"), { code: "EACCES" });
  kill.mockImplementation(() => {
    throw failure;
  });
  expect(() => isProcessAlive(process.pid)).toThrow(failure);
});

it("compares full identities by PID, start time and executable path", () => {
  expect(processIdentitiesEqual(recorded, { ...recorded })).toBe(true);
  expect(processIdentitiesEqual(recorded, { ...recorded, pid: recorded.pid + 1 })).toBe(false);
  expect(processIdentitiesEqual(recorded, { ...recorded, startTimeUtc: "new-token" })).toBe(false);
  expect(processIdentitiesEqual(recorded, { ...recorded, executablePath: "/other" })).toBe(false);
  expect(processIdentitiesEqual(null, recorded)).toBe(false);
  expect(processIdentitiesEqual({ pid: 1 }, { pid: 1 })).toBe(false);
  expect(
    processIdentitiesEqual(
      { ...recorded, executablePath: "/CASE" },
      { ...recorded, executablePath: "/case" },
    ),
  ).toBe(process.platform === "win32");
  for (const missing of [null, ""]) {
    expect(
      processIdentitiesEqual(
        { ...recorded, startTimeUtc: missing },
        { ...recorded, startTimeUtc: missing },
      ),
    ).toBe(false);
    expect(
      processIdentitiesEqual(
        { ...recorded, executablePath: missing },
        { ...recorded, executablePath: missing },
      ),
    ).toBe(false);
  }
});

it("verifies a real child identity, refuses it while alive and accepts its observed exit", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await once(child, "spawn");
    assert.ok(child.pid);
    expect(isProcessAlive(child.pid)).toBe(true);
    const identity = observeProcessIdentity(child.pid);
    assert.ok(
      identity?.startTimeUtc && identity.executablePath,
      "native observation must be complete",
    );
    expect(identity.pid).toBe(child.pid);
    expect(
      processIdentitiesEqual(identity, { ...identity, startTimeUtc: "wrong-start-token" }),
    ).toBe(false);
    expect(
      processIdentitiesEqual(identity, {
        ...identity,
        executablePath: "/definitely/not/this/binary",
      }),
    ).toBe(false);
    expect(() => assertPreviousProcessEnded(identity)).toThrow(/still alive/);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    expect(isProcessAlive(child.pid)).toBe(false);
    expect(() => assertPreviousProcessEnded(identity)).not.toThrow();
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
}, 30_000);

it("refuses a living observer identity and accepts a vanished one without re-observation", () => {
  const self = observeProcessIdentity(process.pid);
  assert.ok(self?.startTimeUtc && self.executablePath);
  expect(() => assertPreviousProcessEnded(self)).toThrow(/still alive/);
  const observe = vi.fn();
  expect(() =>
    assertPreviousProcessEnded({ ...recorded, pid: 2_147_483_647 }, { observe }),
  ).not.toThrow();
  expect(observe).not.toHaveBeenCalled();
  expect(() => assertPreviousProcessEnded(null)).not.toThrow();
  expect(() => assertPreviousProcessEnded(undefined)).not.toThrow();
  expect(() => assertPreviousProcessEnded({ pid: process.pid })).toThrow(/invalid/);
});

it.each([null, ""])("refuses an alive PID with recorded incomplete fields (%s)", (missing) => {
  const observe = vi.fn();
  expect(() =>
    assertPreviousProcessEnded({ ...recorded, startTimeUtc: missing }, { observe }),
  ).toThrow(/alive without a full identity/);
  expect(() =>
    assertPreviousProcessEnded({ ...recorded, executablePath: missing }, { observe }),
  ).toThrow(/alive without a full identity/);
  expect(() =>
    assertPreviousProcessEnded(createProcessIdentity({ pid: process.pid }), { observe }),
  ).toThrow(/alive without a full identity/);
  expect(observe).not.toHaveBeenCalled();
});

it("refuses null, partial, empty, unrelated or identical observations for an alive PID", () => {
  const observations = [
    null,
    recorded,
    { ...recorded, startTimeUtc: null },
    { ...recorded, executablePath: null },
    { ...recorded, startTimeUtc: "" },
    { ...recorded, executablePath: "" },
    { ...recorded, pid: recorded.pid + 1 },
  ];
  for (const current of observations) {
    expect(() => assertPreviousProcessEnded(recorded, { observe: () => current })).toThrow(
      /still alive/,
    );
  }
  // A malformed native response cannot prove PID reuse, even if a typed caller is wrong.
  expect(() =>
    assertPreviousProcessEnded(recorded, {
      observe: () => ({ pid: recorded.pid }) as ProcessIdentity,
    }),
  ).toThrow(/still alive/);
});

it("refuses inaccessible observations and preserves unexpected failures", () => {
  const permission = Object.assign(new Error("denied"), { code: "EPERM" });
  expect(() =>
    assertPreviousProcessEnded(recorded, {
      observe: () => {
        throw permission;
      },
    }),
  ).toThrow(/still alive/);
  const unexpected = new Error("observer failed");
  expect(() =>
    assertPreviousProcessEnded(recorded, {
      observe: () => {
        throw unexpected;
      },
    }),
  ).toThrow(unexpected);
});

it("accepts full unequal identities as PID reuse, without sending a termination signal", () => {
  const kill = vi.spyOn(process, "kill");
  for (const current of [
    { ...recorded, startTimeUtc: "new-token" },
    { ...recorded, executablePath: "/new/path" },
  ]) {
    const observe = vi.fn(() => current);
    expect(() => assertPreviousProcessEnded(recorded, { observe })).not.toThrow();
    expect(observe).toHaveBeenCalledWith(recorded.pid);
  }
  expect(kill.mock.calls.every(([pid, signal]) => pid === recorded.pid && signal === 0)).toBe(true);
});
