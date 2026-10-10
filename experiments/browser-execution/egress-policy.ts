/** Pure Squid 7.7 adapter. Host packet enforcement and original-grant teardown remain required.
 * Original OpenBot MIT adapter; no Squid or ipaddr.js source is copied.
 */
import ipaddr from "ipaddr.js";
export class EgressPolicyError extends Error {
  constructor() {
    super("Invalid browser egress policy.");
  }
}
function requirePolicy(condition: unknown): asserts condition {
  if (!condition) throw new EgressPolicyError();
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const PRIVATE_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map(ipaddr.parseCIDR);
const MAPPED_V4 = ipaddr.parse("::ffff:0:0");
// Exact old policy: explicit nonpublic IPv6 CIDRs exclude 2000::/3 and ::ffff:0:0/96.
// Keeping denials explicit also rejects mixed public/private DNS answers in Squid.
export const BLOCKED = Object.freeze([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3ffe::/16",
  "3fff::/20",
  "8000::/1",
  "4000::/2",
  "1000::/4",
  "800::/5",
  "400::/6",
  "200::/7",
  "100::/8",
  "80::/9",
  "40::/10",
  "20::/11",
  "10::/12",
  "8::/13",
  "4::/14",
  "2::/15",
  "1::/16",
  "0:8000::/17",
  "0:4000::/18",
  "0:2000::/19",
  "0:1000::/20",
  "0:800::/21",
  "0:400::/22",
  "0:200::/23",
  "0:100::/24",
  "0:80::/25",
  "0:40::/26",
  "0:20::/27",
  "0:10::/28",
  "0:8::/29",
  "0:4::/30",
  "0:2::/31",
  "0:1::/32",
  "0:0:8000::/33",
  "0:0:4000::/34",
  "0:0:2000::/35",
  "0:0:1000::/36",
  "0:0:800::/37",
  "0:0:400::/38",
  "0:0:200::/39",
  "0:0:100::/40",
  "0:0:80::/41",
  "0:0:40::/42",
  "0:0:20::/43",
  "0:0:10::/44",
  "0:0:8::/45",
  "0:0:4::/46",
  "0:0:2::/47",
  "0:0:1::/48",
  "0:0:0:8000::/49",
  "0:0:0:4000::/50",
  "0:0:0:2000::/51",
  "0:0:0:1000::/52",
  "0:0:0:800::/53",
  "0:0:0:400::/54",
  "0:0:0:200::/55",
  "0:0:0:100::/56",
  "0:0:0:80::/57",
  "0:0:0:40::/58",
  "0:0:0:20::/59",
  "0:0:0:10::/60",
  "0:0:0:8::/61",
  "0:0:0:4::/62",
  "0:0:0:2::/63",
  "0:0:0:1::/64",
  "::8000:0:0:0/65",
  "::4000:0:0:0/66",
  "::2000:0:0:0/67",
  "::1000:0:0:0/68",
  "::800:0:0:0/69",
  "::400:0:0:0/70",
  "::200:0:0:0/71",
  "::100:0:0:0/72",
  "::80:0:0:0/73",
  "::40:0:0:0/74",
  "::20:0:0:0/75",
  "::10:0:0:0/76",
  "::8:0:0:0/77",
  "::4:0:0:0/78",
  "::2:0:0:0/79",
  "::1:0:0:0/80",
  "::/81",
  "::8000:0:0/82",
  "::c000:0:0/83",
  "::e000:0:0/84",
  "::f000:0:0/85",
  "::f800:0:0/86",
  "::fc00:0:0/87",
  "::fe00:0:0/88",
  "::ff00:0:0/89",
  "::ff80:0:0/90",
  "::ffc0:0:0/91",
  "::ffe0:0:0/92",
  "::fff0:0:0/93",
  "::fff8:0:0/94",
  "::fffc:0:0/95",
  "::fffe:0:0/96",
]);
function privateV4(value: unknown): string {
  requirePolicy(typeof value === "string" && value.length >= 1 && value.length <= 15);
  try {
    const address = ipaddr.IPv4.parse(value);
    requirePolicy(address.toString() === value && PRIVATE_V4.some((net) => address.match(net)));
    return value;
  } catch {
    throw new EgressPolicyError();
  }
}
function port(value: unknown, minimum = 1): number {
  requirePolicy(
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= 65535,
  );
  return value;
}
function host(value: unknown): string {
  requirePolicy(
    typeof value === "string" &&
      value.length >= 1 &&
      value.length <= 253 &&
      !/[^a-z0-9.-]/.test(value),
  );
  const labels = value.split(".");
  requirePolicy(
    labels.length >= 2 &&
      labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
  );
  requirePolicy(!labels.some((label) => label.startsWith("xn--")));
  requirePolicy(!labels.every((label) => /^(?:0x[0-9a-f]+|[0-9]+)$/.test(label)));
  requirePolicy(labels.at(-1) !== "localhost");
  return value;
}
export type EgressPolicy = {
  listen_address: string;
  listen_port: number;
  client_address: string;
  origins: { scheme: "http" | "https"; host: string; port: number }[];
  forbidden_networks: string[];
};
export function validatePolicy(value: unknown): EgressPolicy {
  const keys = ["listen_address", "listen_port", "client_address", "origins", "forbidden_networks"];
  requirePolicy(
    record(value) &&
      keys.slice(0, 4).every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => keys.includes(key)),
  );
  const listen = privateV4(value.listen_address),
    client = privateV4(value.client_address);
  requirePolicy(listen !== client);
  const listenPort = port(value.listen_port, 1024),
    raw = value.origins;
  requirePolicy(Array.isArray(raw) && raw.length >= 1 && raw.length <= 10);
  const origins: EgressPolicy["origins"] = [];
  for (const item of raw as unknown[]) {
    requirePolicy(record(item) && Object.keys(item).sort().join() === "host,port,scheme");
    requirePolicy(item.scheme === "http" || item.scheme === "https");
    const origin: EgressPolicy["origins"][number] = {
      scheme: item.scheme,
      host: host(item.host),
      port: port(item.port),
    };
    requirePolicy(
      !origins.some(
        (o) => o.scheme === origin.scheme && o.host === origin.host && o.port === origin.port,
      ),
    );
    origins.push(origin);
  }
  const networks: string[] = [],
    rawNetworks = Object.hasOwn(value, "forbidden_networks") ? value.forbidden_networks : [];
  requirePolicy(
    (!Object.hasOwn(value, "forbidden_networks") || value.forbidden_networks !== null) &&
      Array.isArray(rawNetworks) &&
      rawNetworks.length <= 32,
  );
  for (const item of rawNetworks as unknown[]) {
    requirePolicy(
      typeof item === "string" && item.length >= 1 && item.length <= 49 && !item.includes("%"),
    );
    try {
      const [address, bits] = ipaddr.parseCIDR(item);
      const network =
        address.kind() === "ipv4"
          ? ipaddr.IPv4.networkAddressFromCIDR(item)
          : ipaddr.IPv6.networkAddressFromCIDR(item);
      const canonical =
        network instanceof ipaddr.IPv6 ? network.toRFC5952String() : network.toString();
      requirePolicy(canonical + "/" + bits === item);
      // IPv4-mapped overlap must not widen an IPv6-only prohibition into ordinary IPv4.
      requirePolicy(address.kind() !== "ipv6" || !address.match(MAPPED_V4, Math.min(bits, 96)));
    } catch {
      throw new EgressPolicyError();
    }
    if (!networks.includes(item)) networks.push(item);
  }
  return {
    listen_address: listen,
    listen_port: listenPort,
    client_address: client,
    origins,
    forbidden_networks: networks,
  };
}
export function compileEgressPolicy(value: unknown): string {
  const policy = validatePolicy(value);
  const lines = [
    "# OpenBot experimental Squid7.7 policy; host enforcement is still required.",
    `http_port ${policy.listen_address}:${policy.listen_port}`,
    "visible_hostname openbot-browser-egress",
    "cache deny all",
    "cache_mem 0 MB",
    "access_log none",
    "cache_log /dev/null",
    "pid_filename /tmp/openbot-squid.pid",
    "coredump_dir /tmp",
    "netdb_filename none",
    "icp_port 0",
    "htcp_port 0",
    "pinger_enable off",
    "shutdown_lifetime 1 seconds",
    `acl browser_client src ${policy.client_address}/32`,
    "acl connect_method method CONNECT",
    "acl http_protocol proto HTTP",
    "acl named_scope dstdomain -n " + [...new Set(policy.origins.map((o) => o.host))].join(" "),
  ];
  lines.push(...[...BLOCKED, ...policy.forbidden_networks].map((n) => "acl blocked_dst dst " + n));
  for (const [i, origin] of policy.origins.entries()) {
    const escaped = origin.host.replaceAll(".", "\\.");
    lines.push(
      `acl origin${i}_domain dstdomain -n ${origin.host}`,
      `acl origin${i}_exact dstdom_regex -n ^${escaped}$`,
      `acl origin${i}_port port ${origin.port}`,
    );
  }
  lines.push(
    "http_access deny manager",
    "http_access deny !browser_client",
    "http_access deny !named_scope",
    "http_access deny blocked_dst",
  );
  for (const [i, origin] of policy.origins.entries()) {
    const method = origin.scheme === "http" ? "http_protocol !connect_method" : "connect_method";
    lines.push(
      `http_access allow browser_client origin${i}_domain origin${i}_exact origin${i}_port ${method}`,
    );
  }
  return [...lines, "http_access deny all", ""].join("\n");
}
