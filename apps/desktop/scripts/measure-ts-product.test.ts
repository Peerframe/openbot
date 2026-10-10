import { describe, expect, it } from "vitest";
import { ownedRss } from "./measure-ts-product.ts";

describe("native product measurement ownership", () => {
  const table = `40 1 999 /Applications/OpenBot.app/python
103 102 20 /runtime/postgres
100 1 50 /runtime/node
102 100 10 /runtime/postgres-supervisor
104 100 30 /runtime/python3.12
105 100 40 /runtime/node
106 100 5 /bin/ps
200 40 999 /Applications/OpenBot.app/node`;
  it("counts only this controller's descendants, including an out-of-order database child", () => {
    expect(ownedRss(table, 100, [104, 105])).toEqual({
      nativeChildrenRssKiB: 100,
      tsRssKiB: 70,
      controllerRssKiB: 50,
      childCount: 4,
    });
  });
  it("refuses missing owned product PIDs instead of understating memory", () => {
    expect(() => ownedRss(table, 100, [104, 201])).toThrow("owned product process is missing");
    expect(() => ownedRss(table, 100, [40])).toThrow("owned product process is missing");
  });
  it("requires the actual measurement controller and can observe no descendants after stop", () => {
    expect(() => ownedRss(table, 101, [])).toThrow("controller is missing");
    expect(
      ownedRss("100 1 50 /runtime/node\n106 100 5 /bin/ps\n40 1 999 /user/python", 100, [])
        .childCount,
    ).toBe(0);
  });
});
