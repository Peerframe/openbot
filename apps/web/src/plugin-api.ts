import type { PluginContentScope, PluginSnapshot } from "@openbot/protocol";
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
    throw new ApiError(`Plugin request failed (${response.status}).`, response.status);
  }
  return response.json() as Promise<T>;
}
export function listPlugins(signal?: AbortSignal): Promise<PluginSnapshot> {
  return pluginRequest("plugins", signal ? { signal } : {});
}
export function pluginError(cause: unknown): string {
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
