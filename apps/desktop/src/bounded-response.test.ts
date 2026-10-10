import { afterEach, describe, expect, it, vi } from "vitest";
import { isJsonContentType, readBoundedBytes, readBoundedText } from "./bounded-response.js";
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

async function promptly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cancellation held the operation open")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stalledCancellation(bytes = new Uint8Array(), init: ResponseInit = {}) {
  const cancel = vi.fn(() => new Promise<void>(() => undefined));
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.length) controller.enqueue(bytes);
      },
      cancel,
    }),
    init,
  );
  return { response, cancel };
}

import { verifyProductHealth } from "./server-bootstrap.js";
import { proxyDesktopServerRequest } from "./server-proxy.js";

afterEach(() => vi.restoreAllMocks());

describe("Desktop body ownership across real consumers", () => {
  const connection = { status: "configured" as const, serverUrl: "https://openbot.example" };

  it("releases the successful reader and keeps byte identity", async () => {
    const response = streamed([new Uint8Array([0, 255]), new Uint8Array([7])]);
    if (!response.body) throw new Error("Missing synthetic stream");
    expect(await readBoundedBytes(response.body, 3, "overflow")).toEqual(Buffer.from([0, 255, 7]));
    expect(response.body?.locked).toBe(false);
  });

  it("does not wait for failed-read cancellation and releases the reader", async () => {
    const { response, cancel } = stalledCancellation(new Uint8Array(9));
    await expect(promptly(readBoundedText(response, 8))).rejects.toThrow(
      "Response exceeds its byte limit.",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it.each(["health", "session", "enrollment", "proxy"])(
    "rejects %s responses without awaiting untrusted disposal",
    async (consumer) => {
      const { response, cancel } = stalledCancellation(undefined, { status: 302 });
      const result =
        consumer === "health"
          ? verifyDesktopServer(async () => response, connection.serverUrl)
          : consumer === "session"
            ? isDesktopSessionAuthenticated(connection, async () => response)
            : consumer === "enrollment"
              ? issueDesktopNodeEnrollmentToken("node", connection, async () => response)
              : proxyDesktopServerRequest(
                  new Request("openbot://app/api/v1/bots"),
                  connection,
                  async () => response,
                );
      const value = await promptly(result);
      if (consumer === "health") expect(value).toBe("server_redirected");
      else if (consumer === "session") expect(value).toBe(false);
      else if (consumer === "enrollment") expect(value).toEqual({ status: "server-unavailable" });
      else expect(value).toBeInstanceOf(Response);
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    },
  );

  it("disposes rejected declared lengths at the health consumer without opening a reader", async () => {
    const { response, cancel } = stalledCancellation(undefined, {
      headers: { "content-type": "application/json", "content-length": "4097" },
    });
    await expect(
      promptly(verifyDesktopServer(async () => response, connection.serverUrl)),
    ).resolves.toBe("not_openbot_server");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("refuses an oversized streamed renderer request before network and releases its lock", async () => {
    const { response, cancel } = stalledCancellation(new Uint8Array(3 * 1024 * 1024 + 1));
    const request = new Request("openbot://app/api/v1/bots", {
      method: "POST",
      body: response.body,
      duplex: "half",
    } as RequestInit);
    const fetcher = vi.fn();
    const result = await promptly(proxyDesktopServerRequest(request, connection, fetcher));
    expect(result?.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(request.body?.locked).toBe(false);
  });

  it.each([
    [
      "application/jsonx",
      '{"ok":true,"service":"openbot-server","phase":"typescript-product-candidate"}',
      false,
    ],
    [
      "Application/JSON; charset=utf-8",
      '{"ok":true,"service":"openbot-server","phase":"typescript-product-candidate"}',
      true,
    ],
    ["application/json", '{"ok":true,"service":"openbot-server","phase":"wrong"}', false],
  ] as const)(
    "keeps Server startup health's phase and exact JSON media type: %s",
    async (type, body, accepted) => {
      const response = new Response(body, { headers: { "content-type": type } });
      const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
      await expect(verifyProductHealth("http://127.0.0.1:39100")).resolves.toBe(accepted);
      expect(fetcher).toHaveBeenCalledWith(
        "http://127.0.0.1:39100/health",
        expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
      );
      expect(response.body?.locked).toBe(false);
    },
  );

  it("bounds Python startup bytes even when cancellation never finishes", async () => {
    const { response, cancel } = stalledCancellation(new Uint8Array(4097), {
      headers: { "content-type": "application/json" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(promptly(verifyProductHealth("http://127.0.0.1:39100"))).resolves.toBe(
      false,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
});
