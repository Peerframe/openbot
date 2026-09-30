import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewedPluginCatalogSchema } from "./plugin-catalog.js";

const catalog = JSON.parse(
  readFileSync(
    new URL("../../../apps/server-python/src/openbot_server/plugin_catalog.json", import.meta.url),
    "utf8",
  ),
);
describe("reviewed plugin catalog", () => {
  it("accepts the actual pinned developer template and rejects unreviewed or unbound entries", () => {
    expect(reviewedPluginCatalogSchema.parse(catalog).entries[0]?.distribution).toBe(
      "self-hosted-template",
    );
    for (const mutate of [
      (v: typeof catalog) => {
        v.entries[0].review.status = "pending";
      },
      (v: typeof catalog) => {
        v.entries[0].sourceCommit = "0".repeat(40);
      },
      (v: typeof catalog) => {
        v.entries[0].endpoint = "http://private";
      },
      (v: typeof catalog) => {
        v.entries[0].sourceUrl = "https://user:token@github.com/";
      },
      (v: typeof catalog) => {
        v.entries.push(v.entries[0]);
      },
    ]) {
      const value = structuredClone(catalog);
      mutate(value);
      expect(reviewedPluginCatalogSchema.safeParse(value).success).toBe(false);
    }
  });
});
