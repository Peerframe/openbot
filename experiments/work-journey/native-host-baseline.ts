/** Read-only identity/firewall comparison; never inspects container credentials or changes the host. */
import { createHash } from "node:crypto";
import { readKernelText } from "../linux-execution/output-capacity.ts";
import { requireFact } from "../linux-execution/protected-io.ts";
import type { NativeCommand } from "../linux-execution/native-unit.ts";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function firewallText(value: string) {
  return value
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .replace(/\[\d+:\d+\]/g, "[0:0]");
}
export function nftSemantics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nftSemantics);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["packets", "bytes", "metainfo"].includes(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, nftSemantics(item)]),
    );
  return value;
}
export async function snapshotHost(
  run: NativeCommand,
  docker: string,
  config: string,
  read = readKernelText,
) {
  const cli = [docker, "--config", config, "--host", "unix:///var/run/docker.sock"],
    identities = (await run([...cli, "ps", "--no-trunc", "--format", "{{.ID}}"]))
      .split(/\s+/)
      .filter(Boolean)
      .sort();
  requireFact(
    identities.length <= 128 &&
      new Set(identities).size === identities.length &&
      identities.every((id) => /^[a-f0-9]{64}$/.test(id)),
    "invalid_container_identity",
  );
  const containers = [];
  for (const identity of identities) {
    const shape =
      '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"status":{{json .State.Status}},"restarts":{{json .RestartCount}}}';
    containers.push(JSON.parse(await run([...cli, "inspect", "--format", shape, identity])));
  }
  const firewall: Record<string, string> = {};
  for (const binary of [
    "iptables-save",
    "ip6tables-save",
    "iptables-legacy-save",
    "ip6tables-legacy-save",
  ])
    firewall[binary] = hash(firewallText(await run(["/usr/sbin/" + binary])));
  firewall.nft = hash(
    JSON.stringify(
      nftSemantics(JSON.parse(await run(["/usr/sbin/nft", "--json", "list", "ruleset"]))),
    ),
  );
  return {
    containers,
    firewall,
    sysctl: Object.fromEntries(
      ["ipv4/ip_forward", "ipv6/conf/all/forwarding"].map((name) => [
        name,
        read("/proc/sys/net/" + name),
      ]),
    ),
  };
}
