import type { EmployeeExportPreview } from "@openbot/domain";
import { ApiError, fetchEmployeeTemplate } from "./api";
import { getOpenBotDesktopBridge } from "./desktop-runtime";

/** Shell-owned save flow. The API client only fetches and verifies server bytes. */
export async function downloadEmployeeTemplate(
  botId: string,
  preview: EmployeeExportPreview,
): Promise<"saved" | "cancelled"> {
  const desktop = getOpenBotDesktopBridge();
  if (desktop) {
    const result = await desktop.saveEmployeeTemplate?.({
      botId,
      packageId: preview.packageId,
      generatedAt: preview.generatedAt,
      downloadReviewToken: preview.downloadReviewToken,
      ...(preview.format === "openbot.employee/v2" ? { includeSkillContent: true } : {}),
    });
    if (result?.status === "saved" || result?.status === "cancelled") return result.status;
    if (result?.status === "changed")
      throw new ApiError("员工内容在审核后发生变化，请刷新预览。", 412);
    throw new ApiError(
      result?.status === "exists"
        ? "文件已存在，请换一个文件名。"
        : result?.status === "busy"
          ? "请先完成当前保存操作。"
          : "无法保存员工模板，请检查连接或更新 Desktop。",
      0,
    );
  }

  const blob = await fetchEmployeeTemplate(botId, preview);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = preview.fileName;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  return "saved";
}
