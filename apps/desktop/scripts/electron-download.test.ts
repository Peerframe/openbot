import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadArtifact, type FetchDownloaderOptions } from "@electron/get";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElectronDownloader } from "./electron-download.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openbot-electron-download-"));
  roots.push(root);
  const sleep = vi.fn(
    async (_ms: number, _value?: undefined, _options?: { signal?: AbortSignal | undefined }) => {},
  );
  const warn = vi.fn<(message: string) => void>();
  const downloader = createElectronDownloader({ sleep, warn });
  const target = join(root, "download.zip");
  const content = "synthetic Electron release bytes";
  const details = {
    version: "44.2.0",
    platform: "win32",
    arch: "x64",
    artifactName: "electron",
    cacheRoot: join(root, "cache"),
    tempDirectory: root,
    downloader,
    downloadOptions: { quiet: true },
    checksums: {
      "electron-v44.2.0-win32-x64.zip": createHash("sha256").update(content).digest("hex"),
    },
  };
  return { content, target, details, downloader, sleep, warn };
}

const artifactUrl = "https://example.invalid/electron.zip";

describe("Electron download recovery", () => {
  it("retries a real FetchDownloader 504 response and accepts only verified bytes", async () => {
    const { content, details, sleep, warn } = await fixture();
    let cancelled = false;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 504 },
        ),
      )
      .mockResolvedValueOnce(new Response(content));
    const path = await downloadArtifact(details);
    expect(await readFile(path, "utf8")).toBe(content);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancelled).toBe(true);
    expect(sleep).toHaveBeenCalledWith(1_000, undefined, { signal: undefined });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toContain("https:");
  });

  it("reuses verified packaging bytes in Electron's own installer after a transient response", async () => {
    const { content, details } = await fixture();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 500 }))
      .mockResolvedValueOnce(new Response(content));
    const cached = await downloadArtifact(details);
    expect(fetch).toHaveBeenCalledTimes(2);

    const require = createRequire(import.meta.url);
    const electronRequire = createRequire(require.resolve("electron/package.json"));
    const installer = electronRequire("@electron/get");
    const { downloader: _packagingDownloader, ...installerDetails } = details;
    const installed = await installer.downloadArtifact(installerDetails);
    expect(installed).toBe(cached);
    expect(await readFile(installed, "utf8")).toBe(content);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not wait indefinitely for a failed response body to cancel", async () => {
    const { downloader, target, content } = await fixture();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 504 }))
      .mockResolvedValueOnce(new Response(content));
    await downloader.download(artifactUrl, target, { quiet: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(target, "utf8")).toBe(content);
  });

  it("fails after three transient HTTP attempts", async () => {
    const { downloader, target, sleep } = await fixture();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("unavailable", { status: 504 }));
    await expect(downloader.download(artifactUrl, target, { quiet: true })).rejects.toMatchObject({
      name: "HTTPError",
      response: { status: 504 },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
  });

  it.each([400, 401, 403, 404, 501])("does not retry permanent HTTP %i", async (status) => {
    const { downloader, target, sleep } = await fixture();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("denied", { status }));
    await expect(downloader.download(artifactUrl, target, { quiet: true })).rejects.toMatchObject({
      response: { status },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("recovers a transient transport failure without changing Fetch options", async () => {
    const { downloader, target, content } = await fixture();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
        }),
      )
      .mockResolvedValueOnce(new Response(content));
    await downloader.download(artifactUrl, target, {
      quiet: true,
      headers: { Accept: "application/zip" },
    });
    expect(await readFile(target, "utf8")).toBe(content);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      headers: { Accept: "application/zip" },
      signal: expect.any(AbortSignal),
    });
  });

  it.each(["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "EACCES", "ENOSPC"])(
    "does not retry %s",
    async (code) => {
      const { downloader, target, sleep } = await fixture();
      const error = new TypeError("failed", {
        cause: Object.assign(new Error("failure"), { code }),
      });
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
      await expect(downloader.download(artifactUrl, target, { quiet: true })).rejects.toBe(error);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("does not retry or cache an artifact that fails upstream checksum validation", async () => {
    const { details, sleep } = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("corrupt bytes"));
    await expect(downloadArtifact(details)).rejects.toThrow(/did not match expected checksum/u);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors bounded Retry-After and rejects a longer server delay", async () => {
    const { downloader, target, sleep, content } = await fixture();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("retry", { status: 429, headers: { "Retry-After": "2" } }),
      )
      .mockResolvedValueOnce(new Response(content));
    await downloader.download(artifactUrl, target, { quiet: true });
    expect(sleep).toHaveBeenCalledWith(2_000, undefined, { signal: undefined });
    fetch
      .mockClear()
      .mockResolvedValueOnce(
        new Response("retry later", { status: 503, headers: { "Retry-After": "31" } }),
      );
    sleep.mockClear();
    await expect(downloader.download(artifactUrl, target, { quiet: true })).rejects.toMatchObject({
      response: { status: 503 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("restarts a failed partial transfer and truncates earlier bytes", async () => {
    const { downloader, target, content } = await fixture();
    let pulls = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (pulls++ === 0)
            controller.enqueue(
              new TextEncoder().encode("discard this partial transfer".repeat(100)),
            );
          else
            controller.error(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
        },
      }),
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response(content));
    await downloader.download(artifactUrl, target, { quiet: true });
    expect(await readFile(target, "utf8")).toBe(content);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops immediately on caller cancellation", async () => {
    const { downloader, target, sleep } = await fixture();
    const abort = new AbortController();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error("Missing attempt signal");
      abort.abort();
      signal.throwIfAborted();
      throw new Error("Abort signal did not stop fetch");
    });
    await expect(
      downloader.download(artifactUrl, target, { quiet: true, signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("bounds each attempt at five minutes and stops after the third timeout", async () => {
    const { target } = await fixture();
    vi.useFakeTimers();
    const download = vi.fn(
      (_url: string, _target: string, { signal }: FetchDownloaderOptions) =>
        new Promise<void>((_resolve, reject) => {
          if (!signal) throw new Error("Missing attempt signal");
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const downloader = createElectronDownloader({
      downloader: { download },
      sleep: async () => {},
      warn: vi.fn(),
    });
    const pending = expect(downloader.download(artifactUrl, target)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(15 * 60 * 1_000);
    await pending;
    expect(download).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("download boundary exception and cancellation ownership", () => {
  it.each([undefined, null, 0, "network failed", { code: 42 }, { cause: "ECONNRESET" }])(
    "preserves an unclassified rejection without retry: %j",
    async (failure) => {
      const download = vi.fn(async () => {
        throw failure;
      });
      const sleep = vi.fn(async () => {});
      const downloader = createElectronDownloader({ downloader: { download }, sleep });
      await expect(downloader.download(artifactUrl, "/unused")).rejects.toBe(failure);
      expect(download).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("does not start a download for an already-cancelled caller", async () => {
    const controller = new AbortController();
    const reason = new Error("fixture cancellation");
    controller.abort(reason);
    const download = vi.fn(async () => {});
    const downloader = createElectronDownloader({ downloader: { download } });
    await expect(
      downloader.download(artifactUrl, "/unused", { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(download).not.toHaveBeenCalled();
  });

  it("clears its attempt timer before cancellable backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("cancel during backoff");
    const download = vi.fn(async () => {
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    });
    const sleep = vi.fn(
      async (_ms: number, _value: undefined, options: { signal?: AbortSignal | undefined }) => {
        expect(vi.getTimerCount()).toBe(0);
        expect(options.signal).toBe(controller.signal);
        controller.abort(reason);
        options.signal?.throwIfAborted();
      },
    );
    const downloader = createElectronDownloader({
      downloader: { download },
      sleep,
      warn: () => {},
    });
    await expect(
      downloader.download(artifactUrl, "/unused", { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(download).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds cause traversal, including cyclic errors", async () => {
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    const download = vi.fn(async () => {
      throw cycle;
    });
    const sleep = vi.fn(async () => {});
    await expect(
      createElectronDownloader({ downloader: { download }, sleep }).download(
        artifactUrl,
        "/unused",
      ),
    ).rejects.toBe(cycle);
    expect(download).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
