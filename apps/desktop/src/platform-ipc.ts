import type { DesktopColorSchemeController } from "./color-scheme.js";
import type { DesktopUpdateController } from "./desktop-updates.js";
import {
  type DesktopIpcSender,
  type ExpectedDesktopContents,
  isTrustedDesktopIpcSender,
} from "./ipc-security.js";
import type { DesktopPlatformController } from "./platform-preferences.js";

export interface PlatformIpcPort {
  handle(channel: string, listener: (event: DesktopIpcSender, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
export function registerPlatformIpc(
  ipc: PlatformIpcPort,
  platform: DesktopPlatformController,
  updates: DesktopUpdateController,
  contents: () => ExpectedDesktopContents | undefined,
  focused: () => boolean,
  colorScheme?: DesktopColorSchemeController,
): void {
  const operations: Record<string, (...values: unknown[]) => unknown> = {
    ...(colorScheme
      ? {
          "get-color-scheme": () => colorScheme.state(),
          "set-color-scheme": (value: unknown) => colorScheme.set(value),
        }
      : {}),
    "get-platform-state": () => platform.state(),
    "set-platform-preferences": (value) => platform.update(value),
    "set-unread-badge": (value) => platform.badge(value),
    "get-update-state": () => updates.state(),
    "check-for-updates": () => updates.check(),
    "download-update": () => updates.download(),
    "install-update": () => updates.install(),
  };
  for (const [name, operation] of Object.entries(operations)) {
    const channel = `openbot:${name}`;
    ipc.removeHandler(channel);
    ipc.handle(channel, (event, ...values) => {
      if (!isTrustedDesktopIpcSender(event, contents()))
        throw new Error("Desktop IPC sender is not allowed.");
      const mutation = [
        "set-platform-preferences",
        "set-color-scheme",
        "download-update",
        "install-update",
      ].includes(name);
      if (mutation && !focused()) throw new Error("Desktop window must be focused.");
      const argumentsRequired = [
        "set-platform-preferences",
        "set-color-scheme",
        "set-unread-badge",
      ].includes(name)
        ? 1
        : 0;
      if (values.length !== argumentsRequired)
        throw new TypeError("Invalid Desktop platform arguments.");
      return operation(...values);
    });
  }
}
