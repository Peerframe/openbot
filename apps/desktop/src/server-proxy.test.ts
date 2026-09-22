import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_CONNECTION_CONFIG_FORMAT } from "./connection-config.js";
import { DesktopConnectionController } from "./connection-controller.js";
import {
  bindDesktopEventStreamWindow,
  DesktopEventStreamLifecycle,
  MAXIMUM_DESKTOP_ATTACHMENT_PROXY_REQUEST_BYTES,
  MAXIMUM_DESKTOP_PROXY_REQUEST_BYTES,
  parseDesktopApiRequestUrl,
  proxyDesktopServerRequest,
} from "./server-proxy.js";

const configured = { status: "configured" as const, serverUrl: "https://openbot.example" };

describe("Desktop Server proxy routing", () => {
  it("handles only exact local API URLs", () => {
    expect(parseDesktopApiRequestUrl("openbot://app/api/v1/session")?.pathname).toBe(
      "/api/v1/session",
    );
    for (const url of [
      "openbot://app/index.html",
      "openbot://other/api/v1/session",
      "https://app/api/v1/session",
      "openbot://app/api/v2/session",
      "openbot://app/api/v1/session#fragment",
    ]) {
      expect(parseDesktopApiRequestUrl(url)).toBeUndefined();
    }
  });

  it.each([
    ["/api/v1/automations", "GET"],
    ["/api/v1/automations", "POST"],
    ["/api/v1/automations/scheduled-review", "PATCH"],
    ["/api/v1/automations/scheduled-review", "DELETE"],
  ])("keeps automation route %s %s on the configured Server", async (path, method) => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    const response = await proxyDesktopServerRequest(
      new Request(`openbot://app${path}`, {
        method,
        headers: { "Content-Type": "application/json", "If-Match": '"revision-one"' },
        ...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}),
      }),
      configured,
      fetcher,
    );
    expect(response?.status).toBe(200);
    const [target, init] = fetcher.mock.calls[0] ?? [];
    expect(target).toBe(`https://openbot.example${path}`);
    expect(init).toMatchObject({ method, credentials: "include", redirect: "manual" });
    const headers = new Headers(init?.headers);
    expect(headers.get("if-match")).toBe('"revision-one"');
    expect(headers.get("origin")).toBe(method === "GET" ? null : "https://openbot.example");
  });

  it("rejects renderer credentials on automation requests before network access", async () => {
    const fetcher = vi.fn();
    const response = await proxyDesktopServerRequest(
      new Request("openbot://app/api/v1/automations", {
        method: "POST",
        body: "{}",
        headers: { Authorization: "Bearer renderer-credential" },
      }),
      configured,
      fetcher,
    );
    expect(response?.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves immutable renderer assets to the asset handler", async () => {
    await expect(
      proxyDesktopServerRequest(new Request("openbot://app/index.html"), configured, vi.fn()),
    ).resolves.toBeUndefined();
  });

  it("returns a bounded setup response before any Server is configured", async () => {
    const fetcher = vi.fn();
    const response = await proxyDesktopServerRequest(
      new Request("openbot://app/api/v1/session"),
      { status: "unconfigured" },
      fetcher,
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      error: "OpenBot Desktop is not connected to a Server.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards only narrow request data and sets the exact Server origin on mutations", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            ETag: '"one"',
            "Set-Cookie": "secret=never-expose",
            "X-Private-Backend": "hidden",
          },
        }),
    );
    const response = await proxyDesktopServerRequest(
      new Request("openbot://app/api/v1/channels?limit=2", {
        body: JSON.stringify({ name: "ops" }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Renderer-Secret": "drop-me",
        },
        method: "POST",
      }),
      configured,
      fetcher,
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/json");
    expect(response?.headers.get("etag")).toBe('"one"');
    expect(response?.headers.has("set-cookie")).toBe(false);
    expect(response?.headers.has("x-private-backend")).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    const [target, init] = fetcher.mock.calls[0] ?? [];
    expect(target).toBe("https://openbot.example/api/v1/channels?limit=2");
    expect(init).toMatchObject({ credentials: "include", method: "POST", redirect: "manual" });
    const headers = new Headers(init?.headers);
    expect(headers.get("origin")).toBe("https://openbot.example");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("x-renderer-secret")).toBe(false);
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('{"name":"ops"}');
  });

  it.each(["Authorization", "Cookie", "Proxy-Authorization"])(
    "rejects renderer-supplied %s credentials",
    async (name) => {
      const fetcher = vi.fn();
      const response = await proxyDesktopServerRequest(
        new Request("openbot://app/api/v1/session", { headers: { [name]: "secret" } }),
        configured,
        fetcher,
      );
      expect(response?.status).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "forwards reaction PUT active=%s with the trusted mutation origin",
    async (active) => {
      const payload = JSON.stringify({ emoji: "👍", active });
      const fetcher = vi.fn(async () => Response.json({ reactions: [] }));
      const response = await proxyDesktopServerRequest(
        new Request("openbot://app/api/v1/channels/channel-1/messages/message-1/reactions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: payload,
        }),
        configured,
        fetcher,
      );
      expect(response?.status).toBe(200);
      const [target, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(target).toBe(
        "https://openbot.example/api/v1/channels/channel-1/messages/message-1/reactions",
      );
      expect(init).toMatchObject({ method: "PUT", credentials: "include", redirect: "manual" });
      expect(new Headers(init.headers).get("origin")).toBe("https://openbot.example");
      expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(payload);
    },
  );

  it("rejects unsupported methods and oversized bodies before network access", async () => {
    const fetcher = vi.fn();
    const methodResponse = await proxyDesktopServerRequest(
      new Request("openbot://app/api/v1/session", { method: "PUT" }),
      configured,
      fetcher,
    );
    expect(methodResponse?.status).toBe(405);
    expect(methodResponse?.headers.get("allow")).toBe("DELETE, GET, PATCH, POST");

    const bodyResponse = await proxyDesktopServerRequest(
      new Request("openbot://app/api/v1/session", {
        body: "x".repeat(MAXIMUM_DESKTOP_PROXY_REQUEST_BYTES + 1),
        method: "POST",
      }),
      configured,
      fetcher,
    );
    expect(bodyResponse?.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed on transport errors and Server redirects", async () => {
    const request = () => new Request("openbot://app/api/v1/session");
    const failed = await proxyDesktopServerRequest(
      request(),
      configured,
      vi.fn(async () => Promise.reject(new Error("private network detail"))),
    );
    expect(failed?.status).toBe(502);

    const redirected = await proxyDesktopServerRequest(
      request(),
      configured,
      vi.fn(
        async () =>
          new Response(null, { headers: { Location: "https://other.example" }, status: 302 }),
      ),
    );
    expect(redirected?.status).toBe(502);
  });

  it("streams Server responses without converting them into privileged values", async () => {
    const response = await proxyDesktopServerRequest(
      new Request("openbot://app/api/v1/events", { headers: { Accept: "text/event-stream" } }),
      configured,
      vi.fn(
        async () =>
          new Response("event: ready\ndata: {}\n\n", {
            headers: { "Content-Type": "text/event-stream", "X-Request-Id": "request-1" },
          }),
      ),
    );

    expect(response?.headers.get("x-request-id")).toBe("request-1");
    await expect(response?.text()).resolves.toBe("event: ready\ndata: {}\n\n");
  });
});

describe("single-window event-stream lifecycle", () => {
  const request = (path: string) =>
    new Request(`openbot://app/api/v1/${path}`, {
      headers: { accept: "text/event-stream" },
    });
  it("bounds repeated channel subscriptions without cancelling workspace or ordinary requests", async () => {
    const lifecycle = new DesktopEventStreamLifecycle();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    await lifecycle.forward(request("workspace/events"), configured, fetcher);
    for (let index = 0; index < 12; index++)
      await lifecycle.forward(request(`channels/channel-${index}/events`), configured, fetcher);
    expect(signals[0]?.aborted).toBe(false);
    expect(signals.slice(1, -1).every((signal) => signal.aborted)).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(false);
    await lifecycle.forward(new Request("openbot://app/api/v1/workspace"), configured, fetcher);
    lifecycle.clear();
    expect(signals.slice(0, -1).every((signal) => signal.aborted)).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(false);
    lifecycle.clear();
  });

  it("does not let a late replaced-stream failure remove its successor", async () => {
    const lifecycle = new DesktopEventStreamLifecycle();
    let failFirst: ((response: Response) => void) | undefined;
    const first = lifecycle.forward(
      request("workspace/events"),
      configured,
      () =>
        new Promise((resolve) => {
          failFirst = resolve;
        }),
    );
    let currentSignal: AbortSignal | undefined;
    await lifecycle.forward(request("workspace/events"), configured, async (_input, init) => {
      currentSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    failFirst?.(new Response(null, { status: 503 }));
    await first;
    expect(currentSignal?.aborted).toBe(false);
    lifecycle.clear();
    expect(currentSignal?.aborted).toBe(true);
  });
  it("owns three independent slots and a replaced snapshot cannot cancel its successor", async () => {
    const lifecycle = new DesktopEventStreamLifecycle();
    const signals: AbortSignal[] = [];
    const fetcher = async (_input: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      });
    };
    await lifecycle.forward(request("workspace/events"), configured, fetcher);
    await lifecycle.forward(request("channels/one/events"), configured, fetcher);
    await lifecycle.forward(request("workspace/snapshots"), configured, fetcher);
    await lifecycle.forward(request("workspace/snapshots"), configured, fetcher);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false, true, false]);
    lifecycle.clear();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it.each(["closed", "render-process-gone", "did-start-navigation"])(
    "aborts all upstreams synchronously on window %s even with stalled headers",
    async (event) => {
      const lifecycle = new DesktopEventStreamLifecycle();
      const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
      bindDesktopEventStreamWindow(window, lifecycle);
      const signals: AbortSignal[] = [];
      const completions: Array<(response: Response) => void> = [];
      const fetcher = (_input: string, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        return new Promise<Response>((resolve) => completions.push(resolve));
      };
      const pending = ["workspace/events", "workspace/snapshots", "channels/one/events"].map(
        (path) => lifecycle.forward(request(path), configured, fetcher),
      );
      // forward first validates the bounded request before entering the upstream fetch.
      await Promise.resolve();
      await Promise.resolve();
      expect(signals).toHaveLength(3);
      window.webContents.emit("did-start-navigation", { isMainFrame: false });
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      if (event === "closed") window.emit("closed");
      else window.webContents.emit(event, { isMainFrame: true });
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      for (const resolve of completions) resolve(new Response(null, { status: 503 }));
      await Promise.all(pending);
    },
  );

  it("queued events from a closed window cannot clear a newly opened window's streams", async () => {
    const streams = new DesktopEventStreamLifecycle();
    const oldWindow = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
    bindDesktopEventStreamWindow(oldWindow, streams);
    oldWindow.emit("closed");
    let signal: AbortSignal | undefined;
    await streams.forward(request("workspace/snapshots"), configured, async (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    oldWindow.webContents.emit("did-start-navigation", { isMainFrame: true });
    oldWindow.webContents.emit("render-process-gone");
    expect(signal?.aborted).toBe(false);
    streams.clear();
    expect(signal?.aborted).toBe(true);
  });

  it("the actual connection controller clears all stream slots before persisting a new Server", async () => {
    const lifecycle = new DesktopEventStreamLifecycle();
    const signals: AbortSignal[] = [];
    for (const path of ["workspace/events", "workspace/snapshots", "channels/one/events"])
      await lifecycle.forward(request(path), configured, async (_input, init) => {
        signals.push(init?.signal as AbortSignal);
        return new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        });
      });
    const controller = new DesktopConnectionController({
      clearSessionData: async () => {
        lifecycle.clear();
      },
      confirmServer: async () => true,
      fetch: async () => Response.json({ ok: true, service: "openbot-server" }),
      store: {
        load: async () => ({
          format: DESKTOP_CONNECTION_CONFIG_FORMAT,
          serverUrl: configured.serverUrl,
        }),
        save: async () => {
          expect(signals.every((signal) => signal.aborted)).toBe(true);
        },
      },
    });
    await controller.initialize();
    expect(await controller.configure("https://replacement.example")).toEqual({
      status: "configured",
      serverUrl: "https://replacement.example",
    });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe("Desktop attachment upload proxy", () => {
  const channelId = "550e8400-e29b-41d4-a716-446655440000";
  const uploadPath = `/api/v1/channels/${channelId}/attachments`;
  const encodedChineseName = encodeURIComponent("团队汇总.csv");

  it("forwards x-openbot-filename and exact binary bodies, including empty uploads", async () => {
    for (const bytes of [new Uint8Array(), Uint8Array.from([0, 1, 255, 9, 10])]) {
      const fetcher = vi.fn(async () => new Response("{}", { status: 201 }));
      const response = await proxyDesktopServerRequest(
        new Request(`openbot://app${uploadPath}`, {
          method: "POST",
          body: bytes,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-OpenBot-Filename": "notes.bin",
            "X-Renderer-Secret": "drop-me",
          },
        }),
        configured,
        fetcher,
      );
      expect(response?.status).toBe(201);
      expect(fetcher).toHaveBeenCalledOnce();
      const [target, init] = fetcher.mock.calls[0] ?? [];
      expect(target).toBe(`https://openbot.example${uploadPath}`);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-openbot-filename")).toBe("notes.bin");
      expect(headers.get("content-type")).toBe("application/octet-stream");
      expect(headers.has("x-renderer-secret")).toBe(false);
      expect(headers.get("origin")).toBe("https://openbot.example");
      expect(init?.body).toBeInstanceOf(Uint8Array);
      expect(init?.body).toEqual(bytes);
    }
  });

  it("forwards the percent-encoded Chinese filename the renderer sends", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 201 }));
    const body = Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]);
    const response = await proxyDesktopServerRequest(
      new Request(`openbot://app${uploadPath}`, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-OpenBot-Filename": encodedChineseName,
        },
      }),
      configured,
      fetcher,
    );
    expect(response?.status).toBe(201);
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-openbot-filename")).toBe(encodedChineseName);
    expect(headers.get("x-openbot-filename")).toBe("%E5%9B%A2%E9%98%9F%E6%B1%87%E6%80%BB.csv");
    expect(fetcher.mock.calls[0]?.[1]?.body).toEqual(body);
  });

  it.each([
    MAXIMUM_DESKTOP_PROXY_REQUEST_BYTES + 1,
    MAXIMUM_DESKTOP_ATTACHMENT_PROXY_REQUEST_BYTES,
  ])(
    "accepts attachment bodies above 3 MiB and up to the 20 MiB Server task budget (%s bytes)",
    async (byteLength) => {
      const fetcher = vi.fn(async () => new Response("{}", { status: 201 }));
      const bytes = new Uint8Array(byteLength);
      bytes[0] = 7;
      bytes[bytes.length - 1] = 9;
      const response = await proxyDesktopServerRequest(
        new Request(`openbot://app${uploadPath}`, {
          method: "POST",
          body: bytes,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-OpenBot-Filename": "large.bin",
          },
        }),
        configured,
        fetcher,
      );
      expect(response?.status).toBe(201);
      const forwarded = fetcher.mock.calls[0]?.[1]?.body as Uint8Array;
      expect(forwarded.byteLength).toBe(bytes.byteLength);
      expect(forwarded[0]).toBe(7);
      expect(forwarded.at(-1)).toBe(9);
    },
  );

  it("rejects attachment bodies above 20 MiB before network access", async () => {
    const fetcher = vi.fn();
    const response = await proxyDesktopServerRequest(
      new Request(`openbot://app${uploadPath}`, {
        method: "POST",
        body: new Uint8Array(MAXIMUM_DESKTOP_ATTACHMENT_PROXY_REQUEST_BYTES + 1),
        headers: {
          "Content-Type": "application/octet-stream",
          "X-OpenBot-Filename": "too-large.bin",
        },
      }),
      configured,
      fetcher,
    );
    expect(response?.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the 3 MiB cap and omits x-openbot-filename on unrelated POSTs", async () => {
    const channelFetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    const channelResponse = await proxyDesktopServerRequest(
      new Request("openbot://app/api/v1/channels", {
        method: "POST",
        body: JSON.stringify({ name: "ops" }),
        headers: {
          "Content-Type": "application/json",
          "X-OpenBot-Filename": encodedChineseName,
        },
      }),
      configured,
      channelFetcher,
    );
    expect(channelResponse?.status).toBe(200);
    const channelHeaders = new Headers(channelFetcher.mock.calls[0]?.[1]?.headers);
    expect(channelHeaders.has("x-openbot-filename")).toBe(false);
    expect(channelHeaders.get("content-type")).toBe("application/json");

    const cleanupFetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    await proxyDesktopServerRequest(
      new Request(`openbot://app${uploadPath}/cleanup`, {
        method: "POST",
        body: JSON.stringify({ olderThanDays: 7 }),
        headers: {
          "Content-Type": "application/json",
          "X-OpenBot-Filename": "ignore-me.bin",
        },
      }),
      configured,
      cleanupFetcher,
    );
    expect(new Headers(cleanupFetcher.mock.calls[0]?.[1]?.headers).has("x-openbot-filename")).toBe(
      false,
    );

    const oversizedFetcher = vi.fn();
    const oversized = await proxyDesktopServerRequest(
      new Request("openbot://app/api/v1/automations", {
        method: "POST",
        body: "x".repeat(MAXIMUM_DESKTOP_PROXY_REQUEST_BYTES + 1),
        headers: {
          "Content-Type": "application/json",
          "X-OpenBot-Filename": encodedChineseName,
        },
      }),
      configured,
      oversizedFetcher,
    );
    expect(oversized?.status).toBe(413);
    expect(oversizedFetcher).not.toHaveBeenCalled();
  });

  it("rejects renderer Authorization on the attachment upload route before network access", async () => {
    const fetcher = vi.fn();
    const response = await proxyDesktopServerRequest(
      new Request(`openbot://app${uploadPath}`, {
        method: "POST",
        body: Uint8Array.from([1]),
        headers: {
          Authorization: "Bearer renderer-credential",
          "Content-Type": "application/octet-stream",
          "X-OpenBot-Filename": "notes.bin",
        },
      }),
      configured,
      fetcher,
    );
    expect(response?.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
