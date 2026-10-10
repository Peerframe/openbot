/** Reads only descriptor-bound members of the original browser cgroup; never reads environments. */
import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
export type BrowserMember = { pid: number; cgroup: string; startTicks: string };
function bytes(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const data = Buffer.alloc(16385);
    let length = 0;
    while (length < data.length) {
      const n = readSync(fd, data, length, data.length - length, null);
      if (!n) break;
      length += n;
    }
    assert(length <= 16384, "Runtime metadata exceeds bound");
    return data.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
const text = (path: string) => new TextDecoder("utf8", { fatal: true }).decode(bytes(path));
function scope(directory: string, group: string): BrowserMember {
  const cgroup = text(directory + "/cgroup").trim();
  assert(cgroup.startsWith("0::"), "Unified cgroup missing");
  const path = cgroup.slice(3),
    stat = text(directory + "/stat"),
    closing = stat.lastIndexOf(")");
  assert(path === group || path.startsWith(group + "/"), "Runtime escaped original cgroup");
  const startTicks = stat
    .slice(closing + 1)
    .trim()
    .split(/\s+/)[19];
  assert(
    closing > 0 && typeof startTicks === "string" && /^\d+$/.test(startTicks),
    "Runtime identity missing",
  );
  return { pid: Number(stat.split(" ", 1)[0]), cgroup: path, startTicks };
}
export function browserMembers(group: string) {
  assert(
    /^\/sys\/fs\/cgroup\/system.slice\/openbot-qualification-deadline-a1-[a-z0-9]{1,12}\.service$/.test(
      group,
    ),
  );
  if (!existsSync(group)) return [];
  const expected = group.slice("/sys/fs/cgroup".length),
    pending = [group],
    seen = new Set<number>(),
    members: BrowserMember[] = [];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    assert(++count <= 4096, "Cgroup tree bound");
    try {
      assert(lstatSync(directory).isDirectory(), "Cgroup path changed");
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        assert(!entry.isSymbolicLink(), "Cgroup alias");
        if (entry.isDirectory()) pending.push(join(directory, entry.name));
      }
      for (const value of text(directory + "/cgroup.procs")
        .split(/\s+/)
        .filter(Boolean)) {
        assert(/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)));
        const pid = Number(value);
        if (seen.has(pid)) continue;
        seen.add(pid);
        assert(seen.size <= 2048, "Browser process bound");
        let fd: number | undefined;
        try {
          fd = openSync(
            "/proc/" + pid,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          const member = scope("/proc/self/fd/" + fd, expected);
          assert.equal(member.pid, pid, "Runtime PID changed");
          members.push(member);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "ENOENT" &&
            (error as NodeJS.ErrnoException).code !== "ESRCH"
          )
            throw error;
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return members;
}
export function browserRuntimeObservation(
  group: string,
  members: BrowserMember[],
  binaries: string,
  proc = "/proc",
) {
  assert.equal(process.platform, "linux", "Linux proc descriptors required");
  assert(group.startsWith("/sys/fs/cgroup/"));
  const identity = (path: string) => {
    const s = statSync(path, { bigint: true });
    return `${s.dev}:${s.ino}`;
  };
  const fixed = new Map(
    ["runsc", "gvisor-bin/gvisor_sentry"].map((name) => [identity(join(binaries, name)), name]),
  );
  const processes: (BrowserMember & { executable: string; argv: string[] })[] = [],
    errors: { pid: number; type: string }[] = [];
  for (const member of members) {
    let fd: number | undefined;
    try {
      assert(Number.isSafeInteger(member.pid) && member.pid > 0);
      fd = openSync(
        join(proc, String(member.pid)),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      // Kernel-owned fd aliases preserve the opened proc directory across exit/PID reuse.
      const directory = "/proc/self/fd/" + fd;
      const check = () => {
        assert.deepEqual(
          scope(directory, group.slice("/sys/fs/cgroup".length)),
          member,
          "Runtime PID/cgroup changed",
        );
        return identity(directory + "/exe");
      };
      const executable = check();
      if (!fixed.has(executable)) continue;
      const raw = bytes(directory + "/cmdline");
      assert.equal(check(), executable, "Runtime executable changed during observation");
      assert.equal(raw.at(-1), 0, "Runtime argv terminator missing");
      processes.push({
        ...member,
        executable: fixed.get(executable)!,
        argv: new TextDecoder("utf8", { fatal: true }).decode(raw.subarray(0, -1)).split("\0"),
      });
    } catch (error) {
      errors.push({ pid: member.pid, type: error instanceof Error ? error.name : "UnknownError" });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return { processes, errors };
}
