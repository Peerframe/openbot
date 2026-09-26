// @vitest-environment jsdom
import type { Artifact } from "@openbot/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ArtifactSaveStatus, getArtifactShellSaver } from "../artifact-shell-save";
import { interact, renderComponent, type RenderedComponent } from "../test/render-component";
import { ArtifactCard } from "./ArtifactCard";

vi.mock("../artifact-shell-save", () => ({ getArtifactShellSaver: vi.fn() }));
afterEach(() => vi.mocked(getArtifactShellSaver).mockReset());
const artifact: Artifact = {
  id: "report-id",
  runId: "run-id",
  name: "研究报告.md",
  mediaType: "text/markdown",
  sha256: "a".repeat(64),
  sizeBytes: 1234,
  createdAt: "2026-09-08T00:00:00.000Z",
};
function useShellSaver(save: (artifactId: string) => Promise<ArtifactSaveStatus>) {
  vi.mocked(getArtifactShellSaver).mockReturnValue({ save });
}
async function click(view: RenderedComponent) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  await interact(() => view.container.querySelector("a")?.dispatchEvent(event));
  return event;
}
describe("task report card", () => {
  it("offers a named download without trying to load text as an image or a new window", async () => {
    const view = await renderComponent(<ArtifactCard artifact={artifact} />);
    try {
      const link = view.container.querySelector("a");
      expect(link?.getAttribute("download")).toBe("研究报告.md");
      expect(link?.getAttribute("href")).toBe("/api/v1/artifacts/report-id/content");
      expect(link?.getAttribute("target")).toBeNull();
      expect(view.container.querySelector("img")).toBeNull();
      expect(view.container.textContent).toContain("Markdown 报告");
    } finally {
      await view.unmount();
    }
  });
  it("saves through the shell adapter with only the artifact identity", async () => {
    const save = vi.fn(async () => "saved" as const);
    useShellSaver(save);
    const view = await renderComponent(<ArtifactCard artifact={artifact} />);
    try {
      const event = await click(view);
      expect(event.defaultPrevented).toBe(true);
      expect(save).toHaveBeenCalledExactlyOnceWith(artifact.id);
      expect(view.container.textContent).toContain("报告已保存");
    } finally {
      await view.unmount();
    }
  });
  it("retains the existing image preview path for PNG artifacts", async () => {
    const view = await renderComponent(
      <ArtifactCard artifact={{ ...artifact, name: "capture.png", mediaType: "image/png" }} />,
    );
    try {
      expect(view.container.querySelector("img")?.getAttribute("alt")).toBe("capture.png");
      expect(view.container.querySelector("a")?.getAttribute("download")).toBeNull();
      expect(view.container.querySelector("a")?.getAttribute("target")).toBe("_blank");
    } finally {
      await view.unmount();
    }
  });
  it("downloads a PNG through the shell adapter when requested by the share list", async () => {
    const save = vi.fn(async () => "saved" as const);
    useShellSaver(save);
    const view = await renderComponent(
      <ArtifactCard
        artifact={{ ...artifact, name: "capture.png", mediaType: "image/png" }}
        downloadImage
      />,
    );
    try {
      const link = view.container.querySelector("a");
      expect(link?.getAttribute("download")).toBe("capture.png");
      expect(link?.getAttribute("target")).toBeNull();
      expect(link?.getAttribute("aria-label")).toBe("下载 capture.png");
      await click(view);
      expect(save).toHaveBeenCalledExactlyOnceWith(artifact.id);
      expect(view.container.textContent).toContain("图片已保存");
    } finally {
      await view.unmount();
    }
  });
  it("hides the saving result while the shell reports cancellation", async () => {
    useShellSaver(vi.fn(async () => "cancelled" as const));
    const view = await renderComponent(<ArtifactCard artifact={artifact} />);
    try {
      const event = await click(view);
      expect(event.defaultPrevented).toBe(true);
      expect(view.container.querySelector(".artifact-save-notice")).toBeNull();
    } finally {
      await view.unmount();
    }
  });
  it("shows the existing-file notice when the shell reports exists", async () => {
    useShellSaver(vi.fn(async () => "exists" as const));
    const view = await renderComponent(<ArtifactCard artifact={artifact} />);
    try {
      await click(view);
      expect(view.container.textContent).toContain("文件已存在，请换一个文件名。");
    } finally {
      await view.unmount();
    }
  });
  it("shows the busy notice when the shell reports busy", async () => {
    useShellSaver(vi.fn(async () => "busy" as const));
    const view = await renderComponent(<ArtifactCard artifact={artifact} />);
    try {
      await click(view);
      expect(view.container.textContent).toContain("请先完成当前保存操作。");
    } finally {
      await view.unmount();
    }
  });
  it("asks the user to update Desktop when the shell reports unavailable", async () => {
    useShellSaver(vi.fn(async () => "unavailable" as const));
    const view = await renderComponent(<ArtifactCard artifact={artifact} />);
    try {
      await click(view);
      expect(view.container.textContent).toContain("无法保存报告，请检查连接或更新 Desktop。");
    } finally {
      await view.unmount();
    }
  });
  it("shows the retry notice when the shell save throws", async () => {
    useShellSaver(
      vi.fn(async () => {
        throw new Error("bridge unavailable");
      }),
    );
    const view = await renderComponent(<ArtifactCard artifact={artifact} />);
    try {
      await click(view);
      expect(view.container.textContent).toContain("无法保存报告，请检查连接后重试。");
    } finally {
      await view.unmount();
    }
  });
  it("keeps a browser download link when the shell saver is absent", async () => {
    const view = await renderComponent(
      <ArtifactCard
        artifact={{ ...artifact, name: "capture.png", mediaType: "image/png" }}
        downloadImage
      />,
    );
    try {
      const link = view.container.querySelector("a");
      expect(link?.getAttribute("download")).toBe("capture.png");
      expect(link?.getAttribute("target")).toBeNull();
      expect(link?.getAttribute("href")).toBe("/api/v1/artifacts/report-id/content");
    } finally {
      await view.unmount();
    }
  });
});
