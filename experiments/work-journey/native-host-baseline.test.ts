/** Counter churn is ignored; container identity, forwarding and firewall meaning remain exact. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { firewallText, nftSemantics, snapshotHost } from "./native-host-baseline.ts";
test("firewall comparison removes only comments and packet counters", () => {
  assert.equal(
    firewallText("# time a\n:INPUT ACCEPT [1:22]\n-A INPUT -j DROP"),
    firewallText("# time b\n:INPUT ACCEPT [9:99]\n-A INPUT -j DROP"),
  );
  assert.notEqual(firewallText(":INPUT ACCEPT [0:0]"), firewallText(":INPUT DROP [0:0]"));
});
test("nft normalization preserves rule order, addresses, actions and handles", () => {
  const a = {
    nftables: [
      { metainfo: { release: "a" } },
      { rule: { handle: 1, expr: [{ counter: { packets: 1, bytes: 20 } }, { accept: null }] } },
    ],
  };
  const b = structuredClone(a);
  b.nftables[0]!.metainfo!.release = "b";
  b.nftables[1]!.rule!.expr[0]!.counter!.packets = 22;
  assert.deepEqual(nftSemantics(a), nftSemantics(b));
  b.nftables[1]!.rule!.handle = 2;
  assert.notDeepEqual(nftSemantics(a), nftSemantics(b));
});
test("host snapshot reads only selected state and cannot mutate Docker or firewall", async () => {
  const calls: readonly string[][] = [];
  const observed = calls as string[][];
  const id = "a".repeat(64),
    status = { id, startedAt: "fixed", status: "running", restarts: 0 };
  const run = async (args: readonly string[]) => {
    observed.push([...args]);
    if (args.includes("ps")) return id;
    if (args.includes("inspect")) {
      assert(
        args.includes(
          '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"status":{{json .State.Status}},"restarts":{{json .RestartCount}}}',
        ),
      );
      assert(!args.join(" ").includes(".Config"));
      return JSON.stringify(status);
    }
    if (args[0]!.endsWith("nft")) return JSON.stringify({ nftables: [] });
    assert(args[0]!.endsWith("-save"));
    assert.equal(args.length, 1);
    return ":INPUT ACCEPT [2:40]";
  };
  const actual = await snapshotHost(run, "/fixed/docker", "/fixed/config", () => "0\n");
  assert.deepEqual(actual.containers, [status]);
  assert.equal(Object.keys(actual.firewall).length, 5);
  assert(
    observed.every(
      (args) => !args.some((v) => ["rm", "stop", "start", "run", "flush", "delete"].includes(v)),
    ),
  );
});
