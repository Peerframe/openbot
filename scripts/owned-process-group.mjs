import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function groupHasLiveMembers(groupId) {
  // Darwin can return EPERM for an existing group containing only unreaped zombies.
  // Inspect numeric identity/state only; never expose other processes' arguments or environment.
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,pgid=,uid=,stat="], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });
  const rows = stdout.trim().split("\n");
  assert(rows.length > 0 && stdout.trim(), "Process-state inspection returned no data.");
  return rows
    .map((row) => {
      const fields = row.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z+<>NsElLsWXI-]+)$/);
      assert(fields, "Process-state inspection returned an invalid record.");
      return { group: Number(fields[2]), zombie: fields[4].startsWith("Z") };
    })
    .some((row) => row.group === groupId && !row.zombie);
}

/** Only adopt a child this process just spawned with detached: true on POSIX. */
export function createOwnedProcessGroup(child, label) {
  let stopped = false;
  let stopping;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  async function signalGroup(signal) {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (value) {
      if (value.code === "ESRCH") return false;
      if (value.code === "EPERM" && !(await groupHasLiveMembers(child.pid))) return false;
      value.message = `${label} owned process group ${child.pid}, signal ${signal}: ${value.message}`;
      throw value;
    }
  }
  async function stopOnce(graceMs) {
    await signalGroup("SIGTERM");
    const deadline = Date.now() + graceMs;
    let active = await signalGroup(0);
    while (active && Date.now() < deadline) {
      await delay(50);
      active = await signalGroup(0);
    }
    if (active) await signalGroup("SIGKILL");
    const killedDeadline = Date.now() + 2000;
    while (await signalGroup(0)) {
      assert(Date.now() < killedDeadline, `${label} process group did not terminate.`);
      await delay(50);
    }
    // A group snapshot may precede libuv reaping our own child; do not leave that reap pending.
    while (child.pid && !exited) {
      assert(Date.now() < killedDeadline, `${label} child exit was not observed.`);
      await delay(10);
    }
    stopped = true;
  }
  return {
    stop({ graceMs = 8000 } = {}) {
      if (stopped) return Promise.resolve();
      // A failed attempt must remain retryable by the driver's final cleanup.
      stopping ??= stopOnce(graceMs).finally(() => {
        stopping = undefined;
      });
      return stopping;
    },
  };
}
