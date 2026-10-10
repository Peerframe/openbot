/** Waits only for the fixed product's Temporal connection; never starts Docker or changes its services. */
import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { NativeStartupContext } from "./native-server.js";
import { RestrictedJsonFile } from "./restricted-json-file.js";
import { TemporalUnavailableError } from "./server-bootstrap.js";

/** Presentation hint only. The Server still validates the complete installation and mTLS files. */
export async function usesLocalDocker(temporalPath: string): Promise<boolean> {
  try {
    const local = await new RestrictedJsonFile(temporalPath, {
      label: "Temporal installation",
      maximumBytes: 16384,
      parse: (text) => {
        const value: unknown = JSON.parse(text);
        return (
          !!value &&
          typeof value === "object" &&
          "temporal_address" in value &&
          typeof value.temporal_address === "string" &&
          /^(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/.test(value.temporal_address)
        );
      },
    }).load();
    if (!local) return false;
    const compose = await lstat(
      join(dirname(dirname(temporalPath)), "services/temporal/profile/compose.yaml"),
    );
    return compose.isFile() && !compose.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Fixed read-only Engine API ping; no shell, environment-selected host, credentials or response logging. */
export async function dockerAvailable(
  signal: AbortSignal,
  sockets = [join(homedir(), ".docker/run/docker.sock"), "/var/run/docker.sock"],
): Promise<boolean> {
  const results = await Promise.all(
    sockets.map(
      (socketPath) =>
        new Promise<boolean>((resolve) => {
          if (signal.aborted) {
            resolve(false);
            return;
          }
          let body = "";
          const call = request(
            { socketPath, method: "GET", path: "/_ping", signal, agent: false },
            (response) => {
              response.setEncoding("utf8");
              response.on("data", (chunk: string) => {
                if (body.length + chunk.length > 16) call.destroy();
                else body += chunk;
              });
              response.on("error", () => finish(false));
              response.on("end", () => finish(response.statusCode === 200 && body === "OK"));
            },
          );
          const timer = setTimeout(() => call.destroy(), 1000);
          function finish(ok: boolean) {
            clearTimeout(timer);
            resolve(ok);
          }
          call.on("error", () => finish(false));
          call.on("close", () => finish(false));
          call.end();
        }),
    ),
  );
  return results.some(Boolean);
}

export async function waitForProductDependencies<T>(
  launch: () => Promise<T>,
  temporalPath: string,
  startup?: NativeStartupContext,
  probes = { usesLocalDocker, dockerAvailable },
): Promise<T> {
  // Non-interactive qualification callers retain their original bounded failure behavior.
  if (!startup) return launch();
  let waiting = false;
  for (;;) {
    startup.signal.throwIfAborted();
    if (waiting) {
      const localDocker = await probes.usesLocalDocker(temporalPath);
      const dockerReady = !localDocker || (await probes.dockerAvailable(startup.signal));
      startup.signal.throwIfAborted();
      startup.waiting(dockerReady ? "temporal_unavailable" : "docker_unavailable", localDocker);
      await startup.waitForRetry();
      startup.signal.throwIfAborted();
      if (!dockerReady) continue;
    }
    try {
      return await launch();
    } catch (error) {
      // Never retry migration, credentials, malformed configuration or unknown execution failures.
      if (!(error instanceof TemporalUnavailableError)) throw error;
      waiting = true;
    }
  }
}
