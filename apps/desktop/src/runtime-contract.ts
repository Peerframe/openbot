export type {
  DesktopRuntimeInfo,
  DesktopConnectionState,
  ConfigureDesktopServerResult,
  DesktopSetupPlanState,
  SaveDesktopSetupPlanResult,
  DesktopLocalWorkerState,
  DesktopLocalWorkerFailureCode,
  DesktopLocalWorkerOperationResult,
  DesktopSidebarMaterialState,
  DesktopNavigationCommand,
  DesktopNavigationMenuState,
  EmployeeTemplateSaveInput,
  EmployeeTemplateSaveResult,
  OpenBotDesktopBridge,
  NativeServerState,
} from "@openbot/protocol";

export const DESKTOP_CONNECTION_STATE_CHANNEL = "openbot:desktop-connection-state";
export const DESKTOP_CONFIGURE_SERVER_CHANNEL = "openbot:desktop-configure-server";
export const DESKTOP_SETUP_PLAN_STATE_CHANNEL = "openbot:desktop-setup-plan-state";
export const DESKTOP_SAVE_SETUP_PLAN_CHANNEL = "openbot:desktop-save-setup-plan";
export const DESKTOP_LOCAL_WORKER_STATE_CHANNEL = "openbot:desktop-local-worker-state";
export const DESKTOP_SETUP_LOCAL_WORKER_CHANNEL = "openbot:desktop-setup-local-worker";
export const DESKTOP_ENABLE_LOCAL_WORKER_CHANNEL = "openbot:desktop-enable-local-worker";
export const DESKTOP_OPEN_LOCAL_WORKER_SETTINGS_CHANNEL =
  "openbot:desktop-open-local-worker-settings";
export const DESKTOP_SET_SIDEBAR_TRANSLUCENCY_CHANNEL = "openbot:set-sidebar-translucency";
export const DESKTOP_SIDEBAR_MATERIAL_STATE_CHANNEL = "openbot:sidebar-material-state";
export const DESKTOP_SIDEBAR_MATERIAL_CHANGED_CHANNEL = "openbot:sidebar-material-changed";
export const DESKTOP_NAVIGATION_COMMAND_CHANNEL = "openbot:navigation-command";
export const DESKTOP_NAVIGATION_MENU_STATE_CHANNEL = "openbot:navigation-menu-state";
