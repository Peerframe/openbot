import { describe, expect, it, vi } from "vitest";
import { isJsonContentType, readBoundedText } from "./bounded-response.js";
import { verifyDesktopServer } from "./connection-controller.js";
import {
  isDesktopSessionAuthenticated,
  issueDesktopNodeEnrollmentToken,
} from "./desktop-server-actions.js";

function streamed(chunks: Uint8Array[], cancel = vi.fn(), headers: HeadersInit = {}) {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    }),
    { headers },
  );
}

describe("bounded Desktop Server response", () => {
  it("decodes a multibyte character across chunks at the exact byte limit", async () => {
    const bytes = new TextEncoder().encode("a中😀");
    await expect(
      readBoundedText(streamed([bytes.slice(0, 3), bytes.slice(3, 6), bytes.slice(6)]), 8),
    ).resolves.toBe("a中😀");
    await expect(readBoundedText(new Response(null), 0)).resolves.toBe("");
  });

  it.each(["-1", "1.5", "NaN", "Infinity", "9007199254740992", "9"])(
    "refuses an invalid declared length %s before consuming the stream",
    async (length) => {
      const response = streamed([new Uint8Array([1])], vi.fn(), { "content-length": length });
      await expect(readBoundedText(response, 8)).rejects.toThrow("Response length is invalid.");
      expect(response.bodyUsed).toBe(false);
    },
  );

  it("enforces streamed bytes despite a false short length and preserves overflow on cancel failure", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    const response = streamed([new Uint8Array(4), new Uint8Array(5)], cancel, {
      "content-length": "1",
    });
    await expect(readBoundedText(response, 8)).rejects.toThrow("Response exceeds its byte limit.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps malformed UTF-8 and stream read failures as failures", async () => {
    await expect(readBoundedText(streamed([new Uint8Array([0xc3, 0x28])]), 8)).rejects.toThrow();
    const failure = new Error("read failed");
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(failure);
        },
      }),
    );
    await expect(readBoundedText(response, 8)).rejects.toBe(failure);
  });

  it("accepts JSON parameters and case without accepting a different media type", () => {
    expect(isJsonContentType(" Application/JSON ; charset=utf-8")).toBe(true);
    for (const value of [null, "", "text/json", "application/problem+json", "application/jsonx"]) {
      expect(isJsonContentType(value)).toBe(false);
    }
  });
});

describe("Desktop response caller boundaries", () => {
  const connection = { status: "configured" as const, serverUrl: "https://openbot.example" };
  it.each([new Uint8Array([0xc3, 0x28]), new Uint8Array(4097)])(
    "retains distinct health, session and enrollment failure results",
    async (bytes) => {
      const response = (status = 200) =>
        new Response(bytes, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      await expect(verifyDesktopServer(async () => response(), connection.serverUrl)).resolves.toBe(
        "not_openbot_server",
      );
      await expect(isDesktopSessionAuthenticated(connection, async () => response())).resolves.toBe(
        false,
      );
      await expect(
        issueDesktopNodeEnrollmentToken("mac-node", connection, async () => response(201)),
      ).resolves.toEqual({ status: "server-unavailable" });
    },
  );
});
