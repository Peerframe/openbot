import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPostgresSupervisor } from "./postgres-supervisor-build.ts";

describe.skipIf(process.platform !== "darwin")("native macOS database supervisor", () => {
  let root: string;
  let supervisor: string;
  let postgres: string;
  const children = new Set<ChildProcess>();
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-supervisor-"));
    supervisor = join(root, "postgres-supervisor");
    postgres = join(root, "postgres");
    await buildPostgresSupervisor(
      fileURLToPath(new URL("../native/postgres-supervisor.c", import.meta.url)),
      supervisor,
    );
    await writeFile(
      join(root, "fixture.c"),
      `#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
static void finish(int number) { (void)number; _exit(0); }
int main(void) {
  if (getenv("OPENBOT_TEST_EARLY_EXIT")) return 17;
  signal(SIGINT, getenv("OPENBOT_TEST_STUCK") ? SIG_IGN : finish);
  signal(SIGQUIT, getenv("OPENBOT_TEST_STUCK") ? SIG_IGN : finish);
  printf("%d\\n", getpid()); fflush(stdout);
  for (;;) pause();
}
`,
    );
    await promisify(execFile)("/usr/bin/xcrun", [
      "clang",
      "-Wall",
      "-Wextra",
      "-Werror",
      join(root, "fixture.c"),
      "-o",
      postgres,
    ]);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(
      [...children].map(async (child) => {
        child.stdin?.end();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await vi.waitFor(
            () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
            { timeout: 17_000 },
          );
        }
      }),
    );
    children.clear();
  }, 20_000);
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  function launch(env: NodeJS.ProcessEnv = {}, executable = postgres, port = "5432") {
    const child = spawn(supervisor, [executable, root, port], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", ...env },
    });
    children.add(child);
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    const done = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    return {
      child,
      done,
      pid: async () => {
        await vi.waitFor(() => expect(output).toMatch(/^\d+\n$/u), { timeout: 5000 });
        return Number(output.trim());
      },
    };
  }
  function alive(pid: number | undefined) {
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("holds its own child until pipe closure, then reaps it without touching another process", async () => {
    const unrelated = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    children.add(unrelated);
    const f = launch();
    const pid = await f.pid();
    expect(alive(pid)).toBe(true);
    f.child.stdin.end();
    expect(await f.done).toEqual({ code: 0, signal: null });
    expect(alive(pid)).toBe(false);
    expect(alive(unrelated.pid)).toBe(true);
  });
  it("turns a supervisor termination request into child shutdown", async () => {
    const f = launch();
    const pid = await f.pid();
    f.child.kill("SIGTERM");
    expect(await f.done).toEqual({ code: 0, signal: null });
    expect(alive(pid)).toBe(false);
  });
  it("reaps the database child after its launching Node parent is killed", async () => {
    const launcher = join(root, "parent.mjs");
    await writeFile(
      launcher,
      `import {spawn} from 'node:child_process';
const child = spawn(process.argv[2], [process.argv[3], process.argv[4], '5432'], {
  stdio: ['pipe', 'pipe', 'ignore'], env: {PATH: '/usr/bin:/bin'}
});
child.stdout.pipe(process.stdout);
setInterval(() => {}, 1000);
`,
    );
    const parent = spawn(process.execPath, [launcher, supervisor, postgres, root], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.add(parent);
    let output = "";
    parent.stdout.on("data", (data) => {
      output += data;
    });
    await vi.waitFor(() => expect(output).toMatch(/^\d+\n$/u), { timeout: 5000 });
    const pid = Number(output.trim());
    expect(alive(pid)).toBe(true);
    parent.kill("SIGKILL");
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });
  }, 12_000);
  it("reports early child failure without waiting for the parent pipe", async () => {
    const f = launch({ OPENBOT_TEST_EARLY_EXIT: "1" });
    expect(await f.done).toEqual({ code: 17, signal: null });
  });
  it.each(["0", "65536", "5432x"])("rejects invalid port %s before launch", async (port) => {
    const f = launch({}, postgres, port);
    expect(await f.done).toEqual({ code: 64, signal: null });
  });
  it("rejects arbitrary executable names", async () => {
    const f = launch({}, "/bin/sleep");
    expect(await f.done).toEqual({ code: 64, signal: null });
  });
  it("bounds graceful shutdown escalation while retaining direct-child identity", async () => {
    const f = launch({ OPENBOT_TEST_STUCK: "1" });
    const pid = await f.pid();
    f.child.stdin.end();
    expect(await f.done).toEqual({ code: 137, signal: null });
    expect(alive(pid)).toBe(false);
  }, 18_000);
});
