/** Re-enters only the original mount/network namespaces in a single-threaded nsenter child. */
import { closeSync, constants, fstatSync, openSync, readlinkSync } from "node:fs";
import { SubprocessCommander } from "./subprocess.ts";
import { requireFact } from "./protected-io.ts";
export function openNamespace(pid: number, kind: "mnt" | "net", expected: string) {
  requireFact(
    process.platform === "linux" && Number.isSafeInteger(pid) && pid > 0,
    "invalid_namespace_process",
  );
  const match = new RegExp(`^${kind}:\\[([0-9]+)\\]$`).exec(expected);
  requireFact(match, "invalid_namespace_identity");
  const path = `/proc/${pid}/ns/${kind}`;
  requireFact(readlinkSync(path) === expected, "namespace_replaced");
  // These fixed /proc namespace magic links intentionally resolve to a kernel namespace object.
  const fd = openSync(path, constants.O_RDONLY);
  try {
    requireFact(
      fstatSync(fd, { bigint: true }).ino === BigInt(match[1]!) &&
        readlinkSync(`/proc/self/fd/${fd}`) === expected &&
        readlinkSync(path) === expected,
      "namespace_replaced",
    );
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
export async function namespaceCommand(options: {
  pid: number;
  namespaces: { mnt: string; net: string };
  argv: readonly string[];
  environment: Record<string, string>;
  timeoutMs: number;
  captureLimit?: number;
}) {
  const descriptors: number[] = [];
  try {
    descriptors.push(openNamespace(options.pid, "mnt", options.namespaces.mnt));
    descriptors.push(openNamespace(options.pid, "net", options.namespaces.net));
    const runner = new SubprocessCommander({
      binary: "/usr/bin/nsenter",
      environment: options.environment,
      captureLimit: options.captureLimit ?? 1048576,
      namespaceDescriptors: descriptors as [number, number],
    });
    // No --target/--all/--env/user/PID namespace. A recycled PID cannot redirect these open FDs.
    return await runner.run(
      ["--mount=/proc/self/fd/3", "--net=/proc/self/fd/4", "--", ...options.argv],
      options.timeoutMs,
    );
  } finally {
    for (const fd of descriptors) closeSync(fd);
  }
}
export function verifyEnteredNamespaces(expected: { mnt: string; net: string }) {
  requireFact(process.platform === "linux", "linux_required");
  for (const [index, kind] of (["mnt", "net"] as const).entries()) {
    const fd = index + 3;
    requireFact(
      readlinkSync(`/proc/self/fd/${fd}`) === expected[kind] &&
        readlinkSync(`/proc/self/ns/${kind}`) === expected[kind],
      "entered_namespace_changed",
    );
  }
  // Do not leave namespace descriptors open while the helper invokes native lifecycle verbs.
  closeSync(3);
  closeSync(4);
}
