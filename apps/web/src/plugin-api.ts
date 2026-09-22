import type { PluginContentScope, PluginSnapshot } from "@openbot/protocol";
import { type PluginCallReceipt, pluginCallReceiptListSchema } from "@openbot/protocol";
import { ApiError } from "./api";

export type {
  InstalledPlugin as Plugin,
  PendingPluginCall,
  PluginContentItem,
  PluginContentResult,
  PluginContentScope,
  PluginManifest,
  PluginPrompt,
  PluginResource,
  PluginSnapshot,
  PluginTool,
  PluginToolGrant as PluginGrant,
} from "@openbot/protocol";

const compatibilityMessages = {
  authentication_required: "插件需要有效的专用 bearer token；当前不支持 OAuth 登录。",
  access_denied: "插件服务拒绝访问，请检查 token 权限或服务端访问策略。",
  transport_unsupported: "请填写直接的 Streamable HTTP MCP 地址；不支持跳转或旧版 SSE 地址。",
  protocol_unsupported: "插件协商的协议版本不受当前 MCP SDK 支持。",
  schema_unsupported: "插件输入或输出 schema 不兼容；请按插件手册使用有界的同步 draft-07 子集。",
  execution_unsupported: "插件工具要求 task 执行模式；当前只支持直接调用，无法安装此工具目录。",
  catalog_unsupported: "插件工具目录不兼容；请检查名称、重复项、数量与完整单页要求。",
  result_unsupported: "插件返回的结果类型或大小不受支持；需要有界文本和可选结构化 JSON。",
  timeout: "插件检查或调用已超时；不会自动重试。请确认服务状态后重新操作。",
  cancelled: "插件检查或调用已取消；不会自动重试。",
} as const;

class PluginCompatibilityError extends ApiError {
  constructor(
    status: number,
    readonly compatibility: keyof typeof compatibilityMessages,
  ) {
    super(compatibilityMessages[compatibility], status);
  }
}

export async function pluginRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    ...init,
    credentials: "include",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("openbot:unauthorized"));
    const payload: unknown = await response.json().catch(() => null);
    // Only stable reason identifiers cross this boundary; never display remote error text.
    if (
      payload &&
      typeof payload === "object" &&
      "compatibility" in payload &&
      typeof payload.compatibility === "string" &&
      Object.hasOwn(compatibilityMessages, payload.compatibility)
    )
      throw new PluginCompatibilityError(
        response.status,
        payload.compatibility as keyof typeof compatibilityMessages,
      );
    throw new ApiError(`Plugin request failed (${response.status}).`, response.status);
  }
  return response.json() as Promise<T>;
}
export function listPlugins(signal?: AbortSignal): Promise<PluginSnapshot> {
  return pluginRequest("plugins", signal ? { signal } : {});
}
export async function listPluginCallReceipts(
  runId: string,
  signal?: AbortSignal,
): Promise<PluginCallReceipt[]> {
  const deadline = AbortSignal.timeout(10_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted();
  const result = pluginCallReceiptListSchema.safeParse(
    await pluginRequest<unknown>(`runs/${encodeURIComponent(runId)}/plugin-calls`, {
      signal: combined,
      cache: "no-store",
    }),
  );
  combined.throwIfAborted();
  if (
    !result.success ||
    result.data.calls.some((call) => call.runId !== runId) ||
    new Set(result.data.calls.map((call) => call.id)).size !== result.data.calls.length
  )
    throw new Error("工具调用回执无效。");
  return result.data.calls;
}
export function pluginError(cause: unknown): string {
  if (cause instanceof PluginCompatibilityError) return compatibilityMessages[cause.compatibility];
  if (cause instanceof ApiError && cause.status === 409)
    return "配置或工具声明已改变，请重新读取并审核。";
  if (cause instanceof ApiError && cause.status === 400)
    return "插件地址、声明或参数未通过检查。请核对协议要求；本机地址须先加入 Server 的精确白名单。";
  if (cause instanceof ApiError && cause.status === 403)
    return "此 Bot 尚未获得所选插件能力，或权限已被撤销。请核对频道成员与插件授权。";
  if (cause instanceof ApiError && cause.status === 404)
    return "插件或所选资源已不存在，请刷新列表。";
  if (cause instanceof ApiError && [502, 503, 504].includes(cause.status))
    return "插件服务未能连接或返回有效响应。请确认服务已启动、地址和凭据正确，再重新预览。";
  if (cause instanceof DOMException && ["AbortError", "TimeoutError"].includes(cause.name))
    return "请求已取消或超时。请检查插件服务状态后重试。";
  return "操作未确认成功，请刷新当前状态后重试。";
}

export function pluginContentPath(scope: PluginContentScope): string {
  return `channels/${encodeURIComponent(scope.channelId)}/bots/${encodeURIComponent(scope.botId)}/plugin-content`;
}
