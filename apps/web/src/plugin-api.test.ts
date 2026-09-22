import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { pluginError, pluginRequest } from "./plugin-api";

afterEach(() => vi.unstubAllGlobals());

async function requestFailure(payload: unknown, status = 503) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  try {
    await pluginRequest("plugins/preview", { method: "POST", body: "{}" });
  } catch (error) {
    return error;
  }
  throw new Error("Expected failure");
}

describe("plugin compatibility error presentation", () => {
  it.each([
    ["authentication_required", "bearer token"],
    ["access_denied", "访问策略"],
    ["transport_unsupported", "Streamable HTTP"],
    ["protocol_unsupported", "协议版本"],
    ["schema_unsupported", "draft-07"],
    ["execution_unsupported", "task"],
    ["catalog_unsupported", "完整单页"],
    ["result_unsupported", "结果类型"],
    ["timeout", "超时"],
    ["cancelled", "取消"],
  ])("presents fixed %s guidance without remote text", async (compatibility, expected) => {
    const error = await requestFailure({
      compatibility,
      error: "private-remote-message",
      token: "secret-token",
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(pluginError(error)).toContain(expected);
    expect(String(error)).not.toMatch(/private-remote|secret-token/u);
    expect(pluginError(error)).not.toMatch(/private-remote|secret-token/u);
  });

  it.each(["__proto__", "constructor", "unknown_reason", null, { secret: "do not display" }])(
    "falls back safely for unknown reason %j",
    async (compatibility) => {
      const error = await requestFailure({ compatibility, error: "private-remote-message" });
      expect(pluginError(error)).toBe(pluginError(new ApiError("", 503)));
      expect(String(error)).not.toContain("private-remote-message");
    },
  );

  it("preserves the existing status fallback for malformed responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>secret-token</html>", { status: 400 })),
    );
    const error = await pluginRequest("plugins/preview").catch((cause: unknown) => cause);
    expect(pluginError(error)).toBe(pluginError(new ApiError("", 400)));
    expect(String(error)).not.toContain("secret-token");
  });
});
