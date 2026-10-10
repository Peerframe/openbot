/** Read-only observation through the selected bundle's own SDK; creates no Worker or execution. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export interface Poller { identity?: string | null; lastAccessTime?: { seconds?: number | { toString(): string } | null; nanos?: number | null } | null }
export interface PollerResponse { pollers?: Poller[] | null }
export interface ObserverConnection {
  withDeadline<T>(deadline: number, operation: () => Promise<T>): Promise<T>;
  workflowService: { describeTaskQueue(request: { namespace: string; taskQueue: { name: string }; taskQueueType: number }): Promise<PollerResponse> };
}
export function freshIdentities(response: PollerResponse, startedAt: number) {
  const boundary = BigInt(startedAt) * 1000000n;
  return new Set((response.pollers ?? []).filter((poller) => poller.identity && poller.lastAccessTime &&
    BigInt(poller.lastAccessTime.seconds?.toString() ?? "0") * 1000000000n + BigInt(poller.lastAccessTime.nanos ?? 0) >= boundary,
  ).map((poller) => poller.identity));
}
export async function observe(connection: ObserverConnection, namespace: string, queue: string, startedAt: number, { timeoutMs = 35000, intervalMs = 1000 } = {}) {
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    const identities: Set<string | null | undefined>[] = [];
    for (const taskQueueType of [1, 2]) {
      const response = await connection.withDeadline(Math.min(expires, Date.now() + 5000), () =>
        connection.workflowService.describeTaskQueue({ namespace, taskQueue: { name: queue }, taskQueueType }),
      );
      identities.push(freshIdentities(response, startedAt));
    }
    if (identities.some((found) => found.size > 1)) throw new Error("multiple_fresh_worker_identities");
    const identity = [...identities[0]!][0];
    if (identity && identities[0]!.size === 1 && identities[1]!.size === 1 && identities[1]!.has(identity))
      return { format: "openbot.desktop.temporal-pollers/v1", freshWorkflowPollers: 1,
        freshActivityPollers: 1, sameWorkerIdentity: true,
        workerIdentitySha256: createHash("sha256").update(identity).digest("hex") };
    await delay(Math.min(intervalMs, Math.max(0, expires - Date.now())));
  }
  throw new Error("fresh_worker_pollers_not_observed");
}

async function main(args: string[]) {
  const runtimeRoot = args[0]!, configPath = args[1]!, timestamp = args[2]!;
  if (args.length !== 3 || ![runtimeRoot, configPath].every(isAbsolute) || !/^[0-9]+$/.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp)) || Number(timestamp) <= 0) throw new Error("explicit_probe_arguments_required");
  const { loadWorkInstallation, readWorkInstallationFile } = await import(pathToFileURL(join(runtimeRoot, "apps/server/dist/work-installation.js")).href);
  const config = JSON.parse(readWorkInstallationFile(configPath, true, 16384));
  if (!/^openbot-desktop-probe-[0-9a-f-]{36}$/.test(config.queue)) throw new Error("isolated_probe_queue_required");
  const { work } = loadWorkInstallation({ temporal: configPath, fileRoot: join(runtimeRoot, "unused-probe-files"), tokenLimit: 1 });
  const { Connection } = createRequire(join(runtimeRoot, "package.json"))("@temporalio/client");
  const connection = await Connection.connect({ address: work.address, connectTimeout: 5000, interceptors: [], tls: {
    serverNameOverride: work.tls.serverName,
    serverRootCACertificate: readWorkInstallationFile(work.tls.ca, false, 65536),
    clientCertPair: { crt: readWorkInstallationFile(work.tls.certificate, false, 65536), key: readWorkInstallationFile(work.tls.key, true, 65536) },
  } });
  try { return await observe(connection, work.namespace, work.taskQueue, Number(timestamp)); }
  finally { await connection.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch { console.log(JSON.stringify({ ok: false, code: "fresh_worker_pollers_not_observed" })); process.exitCode = 1; }
}
