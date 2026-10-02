// @vitest-environment jsdom
import type { EmployeeImportPreview } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activateEmployeeImport, previewEmployeeImport } from "../api";
import { interact, renderComponent } from "../test/render-component";
import { ImportEmployeeDialog, ImportPreviewDetails } from "./ImportEmployeeDialog";

const preview: EmployeeImportPreview = {
  format: "openbot.employee/v1",
  packageId: "00000000-0000-4000-8000-000000000099",
  generatedAt: "2026-09-04T00:00:00.000Z",
  employee: {
    name: "Researcher",
    role: "研究与事实核查",
    description: "比较多个独立来源，并明确记录证据与限制。",
  },
  recommendedExecutionProfile: "docker-linux",
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
  requestedCapabilities: ["browser"],
  integrity: {
    algorithm: "sha256",
    valid: true,
    digest: "4b6c55f00000000000000000000000000000000000000000000000000000000",
  },
  signature: { status: "unsigned", trusted: false },
  compatibility: {
    hostRequired: true,
    compatibleHosts: [
      {
        id: "node-1",
        name: "Linux worker",
        platform: "linux",
        architecture: "x64",
        deviceClass: "server",
      },
    ],
    missingCapabilities: [],
  },
  quarantine: {
    active: true,
    createsNewIdentity: true,
    importedSkillState: "disabled-pending-review",
    hostAuthority: "none",
    memoryCount: 0,
    canActivate: true,
  },
  issues: [],
  blocked: false,
};

describe("ImportPreviewDetails", () => {
  it("shows descriptive identity, requested capabilities, trust, and authority before activation", () => {
    const html = renderToStaticMarkup(
      <ImportPreviewDetails
        preview={preview}
        employeeName="Researcher"
        confirmed={false}
        onEmployeeNameChange={() => undefined}
        onConfirmedChange={() => undefined}
      />,
    );

    expect(html).toContain("员工资料");
    expect(html).toContain("研究与事实核查");
    expect(html).toContain("比较多个独立来源，并明确记录证据与限制。");
    expect(html).toContain("browser");
    expect(html).toContain("检查多个独立来源，并保留可以复核的引用。");
    expect(html).toContain("evidence-core");
    expect(html).toContain("未签名，发布者身份无法验证");
    expect(html).toContain("我知道发布者身份无法验证");
    expect(html).toContain("不会授予技能、电脑或账号权限");
    expect(html).toContain("禁用，等待审核");
  });

  it("labels an older v1 package that has no biography", () => {
    const html = renderToStaticMarkup(
      <ImportPreviewDetails
        preview={{ ...preview, employee: { name: "Legacy", role: "旧模板" } }}
        employeeName="Legacy"
        confirmed={false}
        onEmployeeNameChange={() => undefined}
        onConfirmedChange={() => undefined}
      />,
    );

    expect(html).toContain("模板未提供简介。");
  });
});

vi.mock("../api", () => ({
  previewEmployeeImport: vi.fn(),
  activateEmployeeImport: vi.fn(),
}));

describe("ImportEmployeeDialog activation", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
  });

  it.each([
    ["unsigned", preview, true],
    [
      "signed",
      { ...preview, signature: { status: "dsse", trusted: true, keyid: "key-1" } } as const,
      false,
    ],
  ] as const)(
    "activates a %s package only after the explicit confirmation",
    async (_, shown, risk) => {
      vi.mocked(previewEmployeeImport).mockResolvedValue(shown as EmployeeImportPreview);
      vi.mocked(activateEmployeeImport).mockResolvedValue(
        {} as Awaited<ReturnType<typeof activateEmployeeImport>>,
      );
      const onActivated = vi.fn();
      const view = await renderComponent(
        <ImportEmployeeDialog onClose={vi.fn()} onActivated={onActivated} />,
      );
      try {
        const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
        const file = new File(["{}"], "researcher.openbot.json", { type: "application/json" });
        await interact(() => {
          Object.defineProperty(input, "files", { configurable: true, value: [file] });
          input?.dispatchEvent(new Event("change", { bubbles: true }));
        });
        const activate = Array.from(view.container.querySelectorAll("button")).find(
          (button) => button.textContent === "激活 Bot",
        );
        expect(activate?.disabled).toBe(true);
        await interact(() =>
          view.container.querySelector<HTMLInputElement>(".ob-dialog-confirm input")?.click(),
        );
        expect(activate?.disabled).toBe(false);
        await interact(() => activate?.click());
        expect(activateEmployeeImport).toHaveBeenCalledWith(
          file,
          shown,
          expect.objectContaining({ employeeName: "Researcher", allowUnsigned: risk }),
        );
        expect(onActivated).toHaveBeenCalledOnce();
      } finally {
        await view.unmount();
      }
    },
  );
});
