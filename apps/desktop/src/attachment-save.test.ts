import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesktopReportSaver } from "./report-save.js";

const channelId = "00000000-0000-4000-8000-000000000001";
const attachmentId = "00000000-0000-4000-8000-000000000002";
it("saves only a scoped, digest verified original through the native dialog and preserves existing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-original-save-"));
  const path = join(directory, "original.docx");
  const bytes = Buffer.from("immutable original");
  const descriptor = {
    id: attachmentId,
    channelId,
    name: "original.docx",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith("/auth/session")
      ? Response.json({ authenticated: true })
      : url.endsWith("/content")
        ? new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } })
        : Response.json({ attachment: descriptor }),
  );
  const choosePath = vi.fn(async () => path);
  const saver = new DesktopReportSaver({
    connection: () => ({ status: "configured", serverUrl: "https://server.example" }),
    fetch: fetcher,
    active: () => true,
    choosePath,
  });
  try {
    expect(await saver.saveAttachment({ channelId, attachmentId })).toEqual({ status: "saved" });
    expect(await readFile(path)).toEqual(bytes);
    expect(choosePath).toHaveBeenCalledWith("original.docx");
    expect(await saver.saveAttachment({ channelId, attachmentId })).toEqual({ status: "exists" });
    await writeFile(path, "retained");
    descriptor.sha256 = "0".repeat(64);
    choosePath.mockClear();
    expect(await saver.saveAttachment({ channelId, attachmentId })).toEqual({
      status: "unavailable",
    });
    expect(choosePath).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("retained");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it.each(["dialog", "session"])("refuses an attachment server switch during %s", async (phase) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-original-switch-"));
  const path = join(directory, "original.docx");
  const bytes = Buffer.from("immutable original");
  let serverUrl = "https://server.example";
  const choosePath = vi.fn(async () => {
    if (phase === "dialog") serverUrl = "https://other.example";
    return path;
  });
  const saver = new DesktopReportSaver({
    connection: () => ({ status: "configured", serverUrl }),
    active: () => true,
    choosePath,
    fetch: async (url) => {
      if (url.endsWith("/auth/session")) {
        if (phase === "session") serverUrl = "https://other.example";
        return Response.json({ authenticated: true });
      }
      return url.endsWith("/content")
        ? new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } })
        : Response.json({
            attachment: {
              id: attachmentId,
              channelId,
              name: "original.docx",
              sizeBytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          });
    },
  });
  try {
    expect(await saver.saveAttachment({ channelId, attachmentId })).toEqual({
      status: "unavailable",
    });
    expect(choosePath).toHaveBeenCalledTimes(1);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
describe("attachment identity IPC boundary", () => {
  it.each([
    {},
    { channelId, attachmentId, path: "/tmp/owned" },
    { channelId, attachmentId: "../other" },
    "https://other.example",
  ])("rejects unexpected renderer input", async (input) => {
    const fetcher = vi.fn();
    const saver = new DesktopReportSaver({
      connection: () => ({ status: "configured", serverUrl: "https://server.example" }),
      fetch: fetcher,
      active: () => true,
      choosePath: vi.fn(),
    });
    expect(await saver.saveAttachment(input)).toEqual({ status: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
