/** Upgrade rejection cases retain the old stopped-engine and single-attempt guarantees. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AdjacentUpgrade, type UpgradePort } from "./temporal-upgrade-fixture.ts";
function fixture() {
  const commands: readonly string[][] = [];
  const port: UpgradePort = {
    command: (args) => {
      (commands as string[][]).push([...args]);
      return "";
    },
    versions: () => ({ temporal: "1.19", temporal_visibility: "1.14" }),
    records: () => ({ temporal: "old", temporal_visibility: "old" }),
    shards: () => ["1", "2", "3", "4"],
    selectTarget: () => {},
    migrate: () => {},
    verifyPrivileges: () => {},
    ready: async () => {},
  };
  return { commands, port, upgrade: new AdjacentUpgrade() };
}
for (const failure of ["schema tool", "history changed", "missing shard", "runtime grants"])
  test(failure + " leaves engine stopped", async () => {
    const f = fixture();
    let ready = false,
      mutated = false;
    f.port.ready = async () => {
      ready = true;
    };
    f.port.migrate = () => {
      mutated = true;
    };
    if (failure === "schema tool")
      f.port.migrate = () => {
        throw new Error("schema tool failed");
      };
    if (failure === "history changed") {
      let count = 0;
      f.port.records = () => ({ temporal: ++count === 1 ? "before" : "after" });
    }
    if (failure === "missing shard") f.port.shards = () => ["1", "2", "3"];
    if (failure === "runtime grants")
      f.port.verifyPrivileges = () => {
        throw new Error("runtime metadata writable");
      };
    await assert.rejects(f.upgrade.run(f.port));
    assert.deepEqual(f.commands, [["stop", "temporal"]]);
    assert.equal(f.upgrade.completed, false);
    assert.equal(ready, false);
    if (failure === "missing shard") assert.equal(mutated, false);
    await assert.rejects(f.upgrade.run(f.port), /once only/);
    assert.equal(f.commands.length, 1);
  });
test("successful upgrade validates preserved metadata and cannot run twice", async () => {
  const f = fixture();
  const receipt = await f.upgrade.run(f.port);
  assert.equal(receipt.schemaHistoryUnchanged, true);
  assert.deepEqual(f.commands, [
    ["stop", "temporal"],
    ["up", "-d", "temporal"],
  ]);
  await assert.rejects(f.upgrade.run(f.port), /once only/);
  assert.equal(f.commands.length, 2);
});
