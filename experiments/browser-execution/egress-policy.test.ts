/** Preserves every former Python compiler assertion; real Squid/kernel behavior is a separate gate. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ipaddr from "ipaddr.js";
import { BLOCKED, compileEgressPolicy, EgressPolicyError } from "./egress-policy.ts";
function example() {
  return {
    listen_address: "10.77.0.1",
    client_address: "10.77.0.2",
    listen_port: 3128,
    origins: [
      { scheme: "http", host: "alpha.example", port: 8080 },
      { scheme: "https", host: "beta.example", port: 8443 },
    ],
    forbidden_networks: ["93.184.216.36/32", "2606:4700:4700::1111/128"],
  };
}
test("tuple scope has no Cartesian product or FTP and exactly preserves the old compiled policy", () => {
  const text = compileEgressPolicy(example());
  assert.equal(
    text,
    readFileSync(new URL("./fixtures/egress-policy.conf", import.meta.url), "utf8"),
  );
  const allows = text.split("\n").filter((line) => line.startsWith("http_access allow "));
  assert.deepEqual(allows, [
    "http_access allow browser_client origin0_domain origin0_exact origin0_port http_protocol !connect_method",
    "http_access allow browser_client origin1_domain origin1_exact origin1_port connect_method",
  ]);
  for (const line of [
    "acl http_protocol proto HTTP",
    "acl origin0_domain dstdomain -n alpha.example",
    "acl origin0_exact dstdom_regex -n ^alpha\\.example$",
    "acl browser_client src 10.77.0.2/32",
  ])
    assert(text.includes(line + "\n"));
  assert(text.indexOf("http_access deny blocked_dst") < text.indexOf(allows[0]!));
  assert(text.endsWith("http_access deny all\n"));
});
for (const name of [
  "127.0.0.1",
  "127.1",
  "0x7f000001",
  "0177.0.0.1",
  "2130706433",
  "[::1]",
  "localhost",
  "a.localhost",
  "a.example\nhttp_access allow all",
  "a.example\n",
  "a.example\r",
  "a.example\x00",
  ".a.example",
  "*.example",
  "a..example",
  "A.example",
  "a.example.",
  "user@a.example",
  "a.example/path",
  "a.example?x",
  "a.example#x",
  "a%2eexample",
  "xn--a.example",
  "测.example",
  "-a.example",
  "single",
  "a".repeat(64) + ".example",
  null,
  true,
  ["a.example"],
])
  test(`reject injected, numeric or noncanonical origin ${JSON.stringify(name)}`, () => {
    const value = example();
    Object.assign(value.origins[0]!, { host: name });
    assert.throws(() => compileEgressPolicy(value), EgressPolicyError);
  });
const changes: unknown[] = [
  null,
  [],
  {},
  { ...example(), include: "/etc/squid.conf" },
  ...[
    { listen_address: "0.0.0.0" },
    { listen_address: "127.0.0.1" },
    { client_address: "10.77.0.1" },
    { client_address: "10.077.0.2" },
    { listen_port: true },
    { listen_port: 80 },
    { origins: [] },
    { origins: new Set(example().origins) },
    { origins: Array.from({ length: 6 }, () => example().origins).flat() },
    { origins: [example().origins[0], example().origins[0]] },
    { forbidden_networks: null },
    { forbidden_networks: undefined },
    ...[
      "10.0.0.1/8",
      "::ffff:0:0/96",
      "::/0",
      "::fffe:0:0/95",
      "::ffff:a00:0/104",
      "10.0.0.0/8\nhttp_access allow all",
      "10.0.0.0/08",
      "2606:4700:4700::1111/64",
      "fe80::%eth0/64",
    ].map((n) => ({ forbidden_networks: [n] })),
    { forbidden_networks: Array(33).fill("10.0.0.0/8") },
  ].map((change) => ({ ...example(), ...change })),
];
for (const [field, value] of [
  ["scheme", "ftp"],
  ["scheme", []],
  ["port", true],
  ["port", 0],
  ["port", 65536],
  ["extra", "x"],
] as const) {
  const item = example();
  Object.assign(item.origins[0]!, { [field]: value });
  changes.push(item);
}
for (const [i, value] of changes.entries())
  test(`closed schema and bounds ${i}`, () =>
    assert.throws(() => compileEgressPolicy(value), EgressPolicyError));
test("input is unchanged and output deterministic; optional networks are deduplicated", () => {
  const value = example(),
    before = structuredClone(value);
  assert.equal(compileEgressPolicy(value), compileEgressPolicy(value));
  assert.deepEqual(value, before);
  assert.equal(
    compileEgressPolicy({
      ...value,
      forbidden_networks: [...value.forbidden_networks, ...value.forbidden_networks],
    }),
    compileEgressPolicy(value),
  );
  const { forbidden_networks: _, ...minimal } = value;
  assert(compileEgressPolicy(minimal));
});
test("explicit private and special denials retain public IPv4/IPv6 and IPv4-mapped answers", () => {
  const networks = BLOCKED.map((n) => ipaddr.parseCIDR(n));
  const blocked = (text: string) => {
    const address = ipaddr.parse(text);
    return networks.some(
      ([net, bits]) => address.kind() === net.kind() && address.match(net, bits),
    );
  };
  for (const address of [
    "0.1.2.3",
    "10.4.3.2",
    "100.64.0.2",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "100:0:0:1::1",
    "2001::1",
    "2001:db8::1",
    "2002:a00:1::",
    "3fff::1",
    "5f00::1",
    "8000::1",
  ])
    assert(blocked(address), address);
  for (const address of ["93.184.216.34", "2606:4700:4700::1111", "::ffff:5db8:d822"])
    assert(!blocked(address), address);
});
