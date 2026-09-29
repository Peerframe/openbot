import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopReportSaver } from "./report-save.js";

const id = "6d472024-ae0c-43a8-8ff7-b583c8eccb26";
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=",
  "base64",
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "openbot-report-save-"));
  directories.push(directory);
  const path = join(directory, "report.md");
  let current = "https://server.example";
  let active = true;
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith("/auth/session")
      ? Response.json({ authenticated: true })
      : new Response("# Verified report\n", {
          headers: {
            "content-type": "text/markdown",
            "content-disposition": "attachment; filename=\"report.md\"; filename*=UTF-8''report.md",
          },
        }),
  );
  const choosePath = vi.fn(async (_name: string): Promise<string | undefined> => path);
  const saver = new DesktopReportSaver({
    connection: () => ({ status: "configured", serverUrl: current }),
    fetch: fetcher,
    active: () => active,
    choosePath,
  });
  return {
    directory,
    path,
    fetcher,
    choosePath,
    saver,
    changeServer: () => {
      current = "https://other.example";
    },
    deactivate: () => {
      active = false;
    },
  };
}
describe("native report saving", () => {
  it("fetches only the configured authenticated artifact and saves a new private Markdown file", async () => {
    const f = await fixture();
    expect(await f.saver.save(id)).toEqual({ status: "saved" });
    expect(await readFile(f.path, "utf8")).toBe("# Verified report\n");
    expect(f.fetcher).toHaveBeenNthCalledWith(
      1,
      `https://server.example/api/v1/artifacts/${id}/content`,
      expect.objectContaining({
        method: "GET",
        credentials: "include",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(f.choosePath).toHaveBeenCalledExactlyOnceWith("report.md");
  });
  it("refuses arbitrary renderer URLs or paths before network and preserves existing files", async () => {
    const f = await fixture();
    for (const value of [
      undefined,
      null,
      {},
      "../report.md",
      "https://evil.example",
      id + "/content",
    ]) {
      expect(await f.saver.save(value)).toEqual({ status: "unavailable" });
    }
    expect(f.fetcher).not.toHaveBeenCalled();
    await writeFile(f.path, "existing");
    expect(await f.saver.save(id)).toEqual({ status: "exists" });
    expect(await readFile(f.path, "utf8")).toBe("existing");
  });
  it("does not follow a symlink at the selected filename", async () => {
    const f = await fixture();
    const target = join(f.directory, "existing.md");
    await writeFile(target, "original");
    await symlink(target, f.path, process.platform === "win32" ? "file" : undefined);
    expect(await f.saver.save(id)).toEqual({ status: "exists" });
    expect(await readFile(target, "utf8")).toBe("original");
  });
  it.each(["cancel", "switch", "logout", "extension", "inactive"])(
    "rechecks authority and destination after the dialog: %s",
    async (mode) => {
      const f = await fixture();
      f.choosePath.mockImplementation(async () => {
        if (mode === "switch") f.changeServer();
        if (mode === "inactive") f.deactivate();
        if (mode === "logout")
          f.fetcher.mockImplementation(async () => Response.json({ authenticated: false }));
        return mode === "cancel"
          ? undefined
          : mode === "extension"
            ? join(f.directory, "report.html")
            : f.path;
      });
      expect(await f.saver.save(id)).toEqual({
        status: mode === "cancel" ? "cancelled" : "unavailable",
      });
      await expect(readFile(f.path)).rejects.toThrow();
    },
  );
  it("refuses a server switch while the final session check is in flight", async () => {
    const f = await fixture();
    const fetchResponse = f.fetcher.getMockImplementation();
    if (!fetchResponse) throw new Error("Fixture fetcher is missing.");
    f.fetcher.mockImplementation(async (url) => {
      const response = await fetchResponse(url);
      if (url.endsWith("/auth/session")) f.changeServer();
      return response;
    });
    expect(await f.saver.save(id)).toEqual({ status: "unavailable" });
    expect(f.choosePath).toHaveBeenCalledTimes(1);
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("saves PNG bytes using a fixed artifact filename and never overwrites", async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async (url) =>
      url.endsWith("/auth/session")
        ? Response.json({ authenticated: true })
        : new Response(pngBytes, {
            headers: { "content-type": "image/png", "content-disposition": "inline" },
          }),
    );
    const path = join(f.directory, "capture.png");
    f.choosePath.mockResolvedValue(path);
    expect(await f.saver.save(id)).toEqual({ status: "saved" });
    expect(f.choosePath).toHaveBeenCalledExactlyOnceWith(`screenshot-${id}.png`);
    expect(await readFile(path)).toEqual(pngBytes);
    expect(await f.saver.save(id)).toEqual({ status: "exists" });
    expect(await readFile(path)).toEqual(pngBytes);
  });
  it.each(["signature", "oversize", "disposition", "extension", "switch", "logout", "inactive"])(
    "rejects an unsafe PNG download: %s",
    async (mode) => {
      const f = await fixture();
      const path = join(f.directory, mode === "extension" ? "capture.md" : "capture.png");
      f.fetcher.mockImplementation(async (url) =>
        url.endsWith("/auth/session")
          ? Response.json({ authenticated: mode !== "logout" })
          : new Response(
              mode === "signature"
                ? new Uint8Array([137, 80, 78, 71])
                : mode === "oversize"
                  ? Buffer.concat([pngBytes, Buffer.alloc(5 * 1024 * 1024)])
                  : pngBytes,
              {
                headers: {
                  "content-type": "image/png",
                  "content-disposition":
                    mode === "disposition" ? 'inline; filename="evil.html"' : "inline",
                },
              },
            ),
      );
      f.choosePath.mockImplementation(async () => {
        if (mode === "switch") f.changeServer();
        if (mode === "inactive") f.deactivate();
        return path;
      });
      expect(await f.saver.save(id)).toEqual({ status: "unavailable" });
      if (["signature", "oversize", "disposition"].includes(mode))
        expect(f.choosePath).not.toHaveBeenCalled();
      await expect(readFile(path)).rejects.toThrow();
    },
  );
  it.each(["redirect", "html", "oversize", "encoding", "filename"])(
    "rejects an untrusted Server response: %s",
    async (mode) => {
      const f = await fixture();
      f.fetcher.mockImplementation(
        async () =>
          new Response(
            mode === "oversize"
              ? "a".repeat(32769)
              : mode === "encoding"
                ? new Uint8Array([255])
                : "# report",
            {
              status: mode === "redirect" ? 302 : 200,
              headers: {
                "content-type": mode === "html" ? "text/html" : "text/markdown",
                "content-disposition": `attachment; filename="report.md"; filename*=UTF-8''${mode === "filename" ? "..%2Fprivate.md" : "report.md"}`,
              },
            },
          ),
      );
      expect(await f.saver.save(id)).toEqual({ status: "unavailable" });
      expect(f.choosePath).not.toHaveBeenCalled();
    },
  );
  it("allows only one native dialog at a time", async () => {
    const f = await fixture();
    let release!: () => void;
    f.choosePath.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const pending = f.saver.save(id);
    await vi.waitFor(() => expect(f.choosePath).toHaveBeenCalledTimes(1));
    expect(await f.saver.save(id)).toEqual({ status: "busy" });
    release();
    expect(await pending).toEqual({ status: "cancelled" });
  });
});

describe("native reviewed Employee template saving", () => {
  const body = '{"format":"openbot.employee/v1","kind":"template"}';
  const input = {
    botId: id,
    packageId: "00000000-0000-4000-8000-000000000099",
    generatedAt: "2026-09-04T00:00:00.000Z",
    downloadReviewToken: createHash("sha256").update(body).digest("hex"),
  };
  const headers = {
    "content-type": "application/vnd.openbot.employee+json; charset=utf-8",
    "content-disposition": 'attachment; filename="ops.openbot-employee.json"',
    etag: `"${input.downloadReviewToken}"`,
  };
  it.each([false, true])(
    "saves the exact reviewed Employee JSON package, signed=%s",
    async (signed) => {
      const f = await fixture();
      const name = signed ? "ops.openbot-employee.dsse.json" : "ops.openbot-employee.json";
      const path = join(f.directory, name);
      f.choosePath.mockResolvedValue(path);
      f.fetcher.mockImplementation(async (url) =>
        url.endsWith("/auth/session")
          ? Response.json({ authenticated: true })
          : new Response(body, {
              headers: {
                ...headers,
                "content-type": signed
                  ? "application/vnd.openbot.employee.dsse+json; charset=utf-8"
                  : headers["content-type"],
                "content-disposition": `attachment; filename="${name}"`,
              },
            }),
      );
      expect(await f.saver.saveEmployeeTemplate(input)).toEqual({ status: "saved" });
      expect(await readFile(path, "utf8")).toBe(body);
      expect(f.choosePath).toHaveBeenCalledExactlyOnceWith(name);
      expect(f.fetcher).toHaveBeenNthCalledWith(
        1,
        `https://server.example/api/v1/bots/${id}/export?packageId=${input.packageId}&generatedAt=2026-09-04T00%3A00%3A00.000Z`,
        expect.objectContaining({
          credentials: "include",
          redirect: "manual",
          headers: expect.objectContaining({ "If-Match": headers.etag }),
        }),
      );
      expect(await f.saver.saveEmployeeTemplate(input)).toEqual({ status: "exists" });
    },
  );
  it("rejects arbitrary input fields and invalid reviewed identities before network access", async () => {
    const f = await fixture();
    for (const value of [
      null,
      {},
      "https://evil.example",
      { ...input, url: "https://evil.example" },
      { ...input, path: "/tmp/package.json" },
      { ...input, botId: "../other" },
      { ...input, packageId: "bad" },
      { ...input, includeSkillContent: "true" },
      { ...input, generatedAt: "2026-02-31T00:00:00.000Z" },
      { ...input, downloadReviewToken: `"${input.downloadReviewToken}"` },
    ])
      expect(await f.saver.saveEmployeeTemplate(value)).toEqual({ status: "unavailable" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("binds instruction selection into the reviewed native download request", async () => {
    const f = await fixture();
    const path = join(f.directory, "bot-v2.json");
    f.choosePath.mockResolvedValue(path);
    f.fetcher.mockImplementation(async (url) =>
      url.endsWith("/auth/session")
        ? Response.json({ authenticated: true })
        : new Response(body, { headers }),
    );
    expect(await f.saver.saveEmployeeTemplate({ ...input, includeSkillContent: true })).toEqual({
      status: "saved",
    });
    expect(await readFile(path, "utf8")).toBe(body);
    const requested = f.fetcher.mock.calls[0]?.[0];
    if (!requested) throw new Error("Missing native download request.");
    expect(new URL(requested).searchParams.get("includeSkillContent")).toBe("true");
    expect(f.fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "If-Match": headers.etag });
  });
  it.each(["mime", "etag", "hash", "oversize", "filename", "redirect", "changed", "json"])(
    "rejects invalid Employee export responses before a dialog: %s",
    async (mode) => {
      const f = await fixture();
      const invalidJson = "not JSON";
      const reviewed =
        mode === "json"
          ? {
              ...input,
              downloadReviewToken: createHash("sha256").update(invalidJson).digest("hex"),
            }
          : input;
      f.fetcher.mockResolvedValue(
        new Response(
          mode === "oversize"
            ? "a".repeat(2 * 1024 * 1024 + 1)
            : mode === "hash"
              ? `${body} `
              : mode === "json"
                ? invalidJson
                : body,
          {
            status: mode === "redirect" ? 302 : mode === "changed" ? 412 : 200,
            headers: {
              ...headers,
              "content-type": mode === "mime" ? "application/json" : headers["content-type"],
              "content-disposition":
                mode === "filename"
                  ? 'attachment; filename="../ops.json"'
                  : headers["content-disposition"],
              etag: mode === "etag" ? '"wrong"' : `"${reviewed.downloadReviewToken}"`,
            },
          },
        ),
      );
      expect(await f.saver.saveEmployeeTemplate(reviewed)).toEqual({
        status: mode === "changed" ? "changed" : "unavailable",
      });
      expect(f.choosePath).not.toHaveBeenCalled();
    },
  );
  it.each(["cancel", "extension", "switch", "logout", "inactive"])(
    "rechecks the destination and session after the Employee save dialog: %s",
    async (mode) => {
      const f = await fixture();
      const path = join(f.directory, mode === "extension" ? "ops.html" : "ops.json");
      f.fetcher.mockImplementation(async (url) =>
        url.endsWith("/auth/session")
          ? Response.json({ authenticated: mode !== "logout" })
          : new Response(body, { headers }),
      );
      f.choosePath.mockImplementation(async () => {
        if (mode === "switch") f.changeServer();
        if (mode === "inactive") f.deactivate();
        return mode === "cancel" ? undefined : path;
      });
      expect(await f.saver.saveEmployeeTemplate(input)).toEqual({
        status: mode === "cancel" ? "cancelled" : "unavailable",
      });
      await expect(readFile(path)).rejects.toThrow();
    },
  );
  it("serializes Employee and artifact native save dialogs", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValue(new Response(body, { headers }));
    let release!: () => void;
    f.choosePath.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const pending = f.saver.saveEmployeeTemplate(input);
    await vi.waitFor(() => expect(f.choosePath).toHaveBeenCalledTimes(1));
    expect(await f.saver.save(id)).toEqual({ status: "busy" });
    release();
    expect(await pending).toEqual({ status: "cancelled" });
  });
});

describe("native save failure releases its byte reader", () => {
  it("settles an oversized report and clears busy even if stream cancellation hangs", async () => {
    const f = await fixture();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(32 * 1024 + 1));
        },
        cancel,
      }),
      { headers: { "content-type": "text/markdown" } },
    );
    f.fetcher.mockResolvedValue(response);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          f.saver.save(id),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Save did not release")), 1000);
          }),
        ]),
      ).resolves.toEqual({ status: "unavailable" });
    } finally {
      clearTimeout(timer);
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(f.choosePath).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValue(Response.json({ error: "refused" }, { status: 403 }));
    expect(await f.saver.save(id)).toEqual({ status: "unavailable" });
  });
});
