// @vitest-environment jsdom
import type { Bot, EmployeeExportPreview } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmployeeExportPreview } from "../api";
import { downloadEmployeeTemplate } from "../employee-template-delivery";
import { interact, renderComponent } from "../test/render-component";
import { ExportEmployeeDialog, ExportPreviewDetails } from "./ExportEmployeeDialog";

const preview: EmployeeExportPreview = {
  format: "openbot.employee/v1",
  kind: "template",
  packageId: "00000000-0000-4000-8000-000000000099",
  fileName: "researcher.openbot-employee.json",
  generatedAt: "2026-09-04T00:00:00.000Z",
  employee: {
    name: "Researcher",
    role: "研究与事实核查",
    description: "比较多个独立来源，并明确记录证据与限制。",
  },
  skills: [
    {
      slug: "source-review",
      name: "来源审核",
      description: "检查多个独立来源，并保留可以复核的引用。",
      version: "1.0.0",
      requiredCapabilities: ["browser"],
      dependencySlugs: ["evidence-core"],
    },
  ],
  employeeName: "Researcher",
  verifiedSkillCount: 1,
  requestedCapabilities: ["browser"],
  includedMemoryCount: 0,
  exclusions: [
    { category: "identity", count: 1, reason: "Source identity stays local." },
    { category: "authority", count: 1, reason: "Authority stays local." },
    { category: "memory", count: 2, reason: "Memory stays local." },
    { category: "work-history", count: 3, reason: "History stays local." },
  ],
  findings: [],
  blocked: false,
  checksum: "4db13fa00000000000000000000000000000000000000000000000000000000",
  downloadReviewToken: "9c4733b00000000000000000000000000000000000000000000000000000000",
  signatureStatus: "unsigned",
  identityOnImport: "new",
  hostAuthority: "none",
};

describe("ExportPreviewDetails", () => {
  it("shows the exact descriptive profile and selected skill metadata before download", () => {
    const html = renderToStaticMarkup(<ExportPreviewDetails preview={preview} />);

    expect(html).toContain("研究与事实核查");
    expect(html).toContain("比较多个独立来源，并明确记录证据与限制。");
    expect(html).toContain("检查多个独立来源，并保留可以复核的引用。");
    expect(html).toContain("evidence-core");
    expect(html).toContain("已验证，将包含");
    expect(html).toContain("明确排除");
    expect(html).toContain("不会携带来源身份或电脑权限");
    expect(html).toContain("当前 Server 未配置发布密钥");
  });

  it("renders truthful empty states for an older profile with no biography or verified skills", () => {
    const html = renderToStaticMarkup(
      <ExportPreviewDetails
        preview={{
          ...preview,
          employee: { name: "Legacy", role: "旧模板" },
          skills: [],
          verifiedSkillCount: 0,
          requestedCapabilities: [],
        }}
      />,
    );

    expect(html).toContain("模板未提供简介。");
    expect(html).toContain("没有已验证技能会进入模板。");
  });
});

vi.mock("../api", () => ({
  getEmployeeExportPreview: vi.fn(),
}));
vi.mock("../employee-template-delivery", () => ({ downloadEmployeeTemplate: vi.fn() }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  vi.mocked(getEmployeeExportPreview).mockResolvedValue(preview);
});
afterEach(() => vi.resetAllMocks());

describe("Employee export native save outcomes", () => {
  const employee = { id: "bot-a", name: "Researcher", role: "Research", status: "idle" } as Bot;
  it.each(["saved", "cancelled"] as const)(
    "reports completion only for a saved file: %s",
    async (status) => {
      vi.mocked(downloadEmployeeTemplate).mockResolvedValue(status);
      const onDownloaded = vi.fn();
      const view = await renderComponent(
        <ExportEmployeeDialog employee={employee} onClose={vi.fn()} onDownloaded={onDownloaded} />,
      );
      try {
        await interact(() =>
          view.container.querySelector<HTMLButtonElement>(".primary-button")?.click(),
        );
        expect(downloadEmployeeTemplate).toHaveBeenCalledExactlyOnceWith(employee.id, preview);
        if (status === "saved")
          expect(onDownloaded).toHaveBeenCalledExactlyOnceWith(preview.fileName);
        else expect(onDownloaded).not.toHaveBeenCalled();
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
      } finally {
        await view.unmount();
      }
    },
  );
  it("refreshes a changed package preview and requires another explicit download", async () => {
    vi.mocked(downloadEmployeeTemplate).mockRejectedValue({ status: 412, message: "Changed" });
    vi.mocked(getEmployeeExportPreview)
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...preview, packageId: "00000000-0000-4000-8000-000000000088" });
    const onDownloaded = vi.fn();
    const view = await renderComponent(
      <ExportEmployeeDialog employee={employee} onClose={vi.fn()} onDownloaded={onDownloaded} />,
    );
    try {
      await interact(() =>
        view.container.querySelector<HTMLButtonElement>(".primary-button")?.click(),
      );
      expect(getEmployeeExportPreview).toHaveBeenCalledTimes(2);
      expect(downloadEmployeeTemplate).toHaveBeenCalledTimes(1);
      expect(onDownloaded).not.toHaveBeenCalled();
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("预览已刷新");
      expect(view.container.querySelector<HTMLButtonElement>(".primary-button")?.disabled).toBe(
        false,
      );
    } finally {
      await view.unmount();
    }
  });
});
