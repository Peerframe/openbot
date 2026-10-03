import { expect, it } from "vitest";
import { createPreviewFetch } from "./transport";
import { createWorld } from "./world";

const origin = "http://127.0.0.1:5179";

it("answers the synthetic workspace and keeps mutations in memory", async () => {
  const world = createWorld();
  const fetchPreview = createPreviewFetch(origin, world);
  const workspace = (await (await fetchPreview("/api/v1/workspace")).json()) as {
    channels: Array<{ id: string }>;
  };
  expect(workspace.channels.map((channel) => channel.id)).toContain("c-market");
  await fetchPreview("/api/v1/channels/c-release/read", { method: "POST" });
  const unread = (await (await fetchPreview("/api/v1/channels/unread")).json()) as {
    unread: Record<string, number>;
  };
  expect(unread.unread["c-release"]).toBeUndefined();
});

it("fails closed for foreign origins and unknown routes", async () => {
  const fetchPreview = createPreviewFetch(origin, createWorld("empty"));
  await expect(fetchPreview("https://example.com/api/v1/workspace")).rejects.toThrow(TypeError);
  // The metered model test is never served: the preview answers only synthetic, free reads.
  const response = await fetchPreview("/api/v1/model-connections/conn-anthropic/test", {
    method: "POST",
    body: "{}",
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "preview_unsupported" });
});
