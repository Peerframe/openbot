/** Fixture-only SDK Worker stop/recreate control; the production HTTP service and queue stay live. */
import type { Worker } from "@temporalio/worker";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type Poller = Pick<Worker, "run" | "shutdown" | "getState">;
export interface RestartControl {
  paused(): Promise<boolean>;
  stopped(): Promise<void>;
  resumed(): Promise<void>;
}
export function fileRestartControl(directory: string): RestartControl {
  const present = async (name: string) => {
    try {
      await access(join(directory, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const mark = (name: string) =>
    writeFile(join(directory, name), String(process.pid), { mode: 0o600 });
  return {
    paused: async () => (await present("pause-worker")) && !(await present("resume-worker")),
    stopped: () => mark("worker-stopped"),
    resumed: () => mark("worker-resumed"),
  };
}
export function restartableBrowserWorker<W extends Poller>(
  first: W,
  create: () => Promise<W>,
  control: RestartControl,
): W {
  const bind = (worker: W) => ({
    run: worker.run.bind(worker),
    shutdown: worker.shutdown.bind(worker),
    getState: worker.getState.bind(worker),
  });
  let current = bind(first),
    closing = false,
    active = false,
    running: Promise<void> | undefined;
  const stopped = new AbortController();
  const wait = async (predicate: () => Promise<boolean>, signal: AbortSignal) => {
    while (!signal.aborted && !(await predicate())) {
      try {
        await delay(100, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
    return !signal.aborted;
  };
  first.getState = () => (active ? "RUNNING" : current.getState());
  first.shutdown = () => {
    closing = true;
    stopped.abort();
    if (current.getState() === "RUNNING") current.shutdown();
  };
  first.run = () =>
    (running ??= (async () => {
      active = true;
      let resuming = false;
      try {
        while (!closing) {
          const poll = current.run(),
            monitor = new AbortController();
          if (resuming) await control.resumed();
          const signal = AbortSignal.any([stopped.signal, monitor.signal]);
          let pause: boolean;
          try {
            pause = await Promise.race([poll.then(() => false), wait(control.paused, signal)]);
          } finally {
            monitor.abort();
          }
          if (pause && current.getState() === "RUNNING") current.shutdown();
          await poll;
          if (!pause || closing) return;
          await control.stopped();
          if (!(await wait(async () => !(await control.paused()), stopped.signal))) return;
          if (closing) return;
          current = bind(await create());
          if (closing) {
            const drained = current.run();
            current.shutdown();
            await drained;
            return;
          }
          resuming = true;
        }
      } finally {
        active = false;
      }
    })());
  return first;
}
