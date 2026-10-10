// Display label for a Desktop keyboard shortcut (⌘ on macOS, Ctrl elsewhere); display only.
import { getOpenBotDesktopBridge } from "./desktop-runtime";

/** This is display metadata only; command authority remains in the native menu. */
export function shortcutLabel(
  key: string,
  platform = getOpenBotDesktopBridge()?.getRuntimeInfo?.().platform,
): string {
  const mac =
    platform === "darwin" ||
    (!platform && typeof navigator !== "undefined" && /Mac/.test(navigator.platform));
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}
