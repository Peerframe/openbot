import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createModelConnection,
  deleteModelConnection,
  discoverConnectionModels,
  getModelServices,
  updateEmployeeModel,
  updateModelConnection,
  verifyModelConnection,
} from "./api";

afterEach(() => vi.restoreAllMocks());

describe("retained feature model service API", () => {
  it("reads model lists for saved and unsaved keys without any inference route", async () => {
    const controller = new AbortController();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: ["vendor/model:version"] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: ["fixture"] })));
    expect(await discoverConnectionModels("connection/1", controller.signal)).toEqual([
      "vendor/model:version",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/model-connections/connection%2F1/models");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    });
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
    const unsaved = {
      presetId: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "synthetic",
    };
    expect(await verifyModelConnection(unsaved, controller.signal)).toEqual(["fixture"]);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/model-connections/verify");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST", signal: controller.signal });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(unsaved);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/test"))).toBe(false);
  });

  it("deletes with the expected revision and keeps the in-use dependency list", async () => {
    const dependencies = {
      error: "model_connection_in_use",
      bots: [{ id: "b", name: "研究助理" }],
      runIds: ["r"],
      ownerDefault: false,
    };
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(dependencies), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true, connectionId: "a/1" })));
    const refusal = await deleteModelConnection("a/1", { expectedRevision: 4 }).catch(
      (cause: unknown) => cause,
    );
    expect(refusal).toBeInstanceOf(ApiError);
    expect((refusal as ApiError).body).toEqual(dependencies);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/model-connections/a%2F1");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ expectedRevision: 4 });
    await deleteModelConnection("a/1", { expectedRevision: 4 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the source snapshot/create/CAS routes", async () => {
    const snapshot = { presets: [], connections: [], customBaseUrls: [] };
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ connection: { id: "a" } })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ connection: { id: "a", revision: 4 } })),
      );
    expect(await getModelServices()).toEqual(snapshot);
    const input = {
      name: "Fixture",
      presetId: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "synthetic-only",
    };
    await createModelConnection(input);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/model-connections");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(input);
    await updateModelConnection("a", { expectedRevision: 3, enabled: false });
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      expectedRevision: 3,
      enabled: false,
    });
  });

  it.each([{ connectionId: "a", modelId: "vendor/model" }, null])(
    "preserves nullable model binding and revision: %o",
    async (model) => {
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ employee: {}, details: { revision: 3 } })),
        );
      await updateEmployeeModel("bot/1", { expectedRevision: 2, model });
      expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/bots/bot%2F1/model");
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH", credentials: "include" });
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
        expectedRevision: 2,
        model,
      });
    },
  );

  it("surfaces revision conflicts without automatic retry", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "model_connection_revision_conflict" }), {
        status: 409,
      }),
    );
    await expect(
      updateModelConnection("a", { expectedRevision: 1, enabled: false }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ApiError.prototype).toBeInstanceOf(Error);
  });
});
