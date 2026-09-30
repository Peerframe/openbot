import type {
  OpenBotDesktopBridge as DesktopBridge,
  DesktopRuntimeInfo,
  DesktopNavigationMenuState as NavigationMenuState,
} from "@openbot/protocol";
export type {
  DesktopConnectionState,
  ConfigureDesktopServerResult,
  DesktopSetupMode,
  DesktopSetupPlanInput,
  DesktopSetupPlanState,
  SaveDesktopSetupPlanResult,
  DesktopLocalWorkerState,
  DesktopLocalWorkerOperationResult,
  DesktopSidebarMaterialState,
  DesktopNavigationCommand,
  EmployeeTemplateSaveInput,
  EmployeeTemplateSaveResult,
  NativeServerState,
} from "@openbot/protocol";

// Older Desktop bridges may omit runtime metadata; feature detection remains local.
export type OpenBotDesktopBridge = Omit<DesktopBridge, "getRuntimeInfo"> & {
  getRuntimeInfo?(): Readonly<DesktopRuntimeInfo>;
};
export type DesktopNavigationMenuState = {
  -readonly [Key in keyof NavigationMenuState]: NavigationMenuState[Key];
};

declare global {
  interface Window {
    openbotDesktop?: OpenBotDesktopBridge;
  }
}

export function getOpenBotDesktopBridge(): OpenBotDesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = window.openbotDesktop;
  if (
    bridge === undefined ||
    typeof bridge.getConnectionState !== "function" ||
    typeof bridge.configureServer !== "function" ||
    typeof bridge.getSetupPlanState !== "function" ||
    typeof bridge.saveSetupPlan !== "function" ||
    typeof bridge.getLocalWorkerState !== "function" ||
    typeof bridge.setupLocalWorker !== "function" ||
    typeof bridge.enableLocalWorker !== "function" ||
    typeof bridge.openLocalWorkerSettings !== "function"
  ) {
    return undefined;
  }
  return bridge;
}
