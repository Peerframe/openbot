import type {
  DesktopNavigationCommand,
  DesktopNavigationMenuState,
  DesktopSidebarMaterialState,
  EmployeeTemplateSaveInput,
  OpenBotDesktopBridge,
} from "./runtime-contract.js";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
const DESKTOP_CONNECTION_STATE_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_CONNECTION_STATE_CHANNEL =
  "openbot:desktop-connection-state";
const DESKTOP_CONFIGURE_SERVER_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_CONFIGURE_SERVER_CHANNEL =
  "openbot:desktop-configure-server";
const DESKTOP_SETUP_PLAN_STATE_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_SETUP_PLAN_STATE_CHANNEL =
  "openbot:desktop-setup-plan-state";
const DESKTOP_SAVE_SETUP_PLAN_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_SAVE_SETUP_PLAN_CHANNEL =
  "openbot:desktop-save-setup-plan";
const DESKTOP_LOCAL_WORKER_STATE_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_LOCAL_WORKER_STATE_CHANNEL =
  "openbot:desktop-local-worker-state";
const DESKTOP_SETUP_LOCAL_WORKER_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_SETUP_LOCAL_WORKER_CHANNEL =
  "openbot:desktop-setup-local-worker";
const DESKTOP_ENABLE_LOCAL_WORKER_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_ENABLE_LOCAL_WORKER_CHANNEL =
  "openbot:desktop-enable-local-worker";
const DESKTOP_OPEN_LOCAL_WORKER_SETTINGS_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_OPEN_LOCAL_WORKER_SETTINGS_CHANNEL =
  "openbot:desktop-open-local-worker-settings";

const DESKTOP_SET_SIDEBAR_TRANSLUCENCY_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_SET_SIDEBAR_TRANSLUCENCY_CHANNEL =
  "openbot:set-sidebar-translucency";
const DESKTOP_SIDEBAR_MATERIAL_STATE_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_SIDEBAR_MATERIAL_STATE_CHANNEL =
  "openbot:sidebar-material-state";
const DESKTOP_SIDEBAR_MATERIAL_CHANGED_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_SIDEBAR_MATERIAL_CHANGED_CHANNEL =
  "openbot:sidebar-material-changed";
const DESKTOP_NAVIGATION_COMMAND_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_NAVIGATION_COMMAND_CHANNEL =
  "openbot:navigation-command";
const DESKTOP_NAVIGATION_MENU_STATE_CHANNEL: typeof import("./runtime-contract.js").DESKTOP_NAVIGATION_MENU_STATE_CHANNEL =
  "openbot:navigation-menu-state";

const shellVersion = process.versions.electron;
if (shellVersion === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(shellVersion)) {
  throw new Error("Electron version is invalid.");
}

const runtimeInfo = Object.freeze({
  kind: "desktop" as const,
  platform: process.platform,
  arch: process.arch,
  shellVersion,
});
const bridge: OpenBotDesktopBridge = Object.freeze({
  beginVoiceCapture: () => {
    // This check runs in the isolated preload, not in renderer-supplied JavaScript.
    if (
      !(navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
        ?.isActive
    )
      return Promise.resolve(false);
    return ipcRenderer.invoke("openbot:begin-voice-capture");
  },
  endVoiceCapture: () => ipcRenderer.invoke("openbot:end-voice-capture"),
  saveAttachment: (input: { channelId: string; attachmentId: string }) =>
    ipcRenderer.invoke("openbot:save-attachment", {
      channelId: input.channelId,
      attachmentId: input.attachmentId,
    }),
  restoreLocalSession: () => ipcRenderer.invoke("openbot:restore-local-session"),
  saveReport: (artifactId: string) => {
    if (
      typeof artifactId !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(artifactId)
    )
      return Promise.resolve({ status: "unavailable" });
    return ipcRenderer.invoke("openbot:save-report", artifactId);
  },
  saveEmployeeTemplate: (input: EmployeeTemplateSaveInput) => {
    if (!isEmployeeTemplateSaveInput(input)) return Promise.resolve({ status: "unavailable" });
    return ipcRenderer.invoke("openbot:save-employee-template", {
      botId: input.botId,
      packageId: input.packageId,
      generatedAt: input.generatedAt,
      downloadReviewToken: input.downloadReviewToken,
      ...(input.includeSkillContent === undefined
        ? {}
        : { includeSkillContent: input.includeSkillContent }),
    });
  },
  getRuntimeInfo: () => runtimeInfo,
  onNavigationCommand: (listener: (command: DesktopNavigationCommand) => void) => {
    if (typeof listener !== "function") return () => {};
    const handleCommand = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isNavigationCommand(value)) listener(value);
    };
    ipcRenderer.on(DESKTOP_NAVIGATION_COMMAND_CHANNEL, handleCommand);
    return () => ipcRenderer.removeListener(DESKTOP_NAVIGATION_COMMAND_CHANNEL, handleCommand);
  },
  updateNavigationMenuState: (state: DesktopNavigationMenuState) => {
    if (!isNavigationMenuState(state)) {
      return Promise.reject(new TypeError("Desktop navigation menu state is invalid."));
    }
    return ipcRenderer.invoke(DESKTOP_NAVIGATION_MENU_STATE_CHANNEL, {
      workspaceReady: state.workspaceReady,
      settingsAvailable: state.settingsAvailable,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
    });
  },
  setSidebarTranslucency: (enabled: boolean) => {
    if (typeof enabled !== "boolean") return Promise.resolve({ status: "unavailable" });
    return ipcRenderer.invoke(DESKTOP_SET_SIDEBAR_TRANSLUCENCY_CHANNEL, enabled);
  },
  getSidebarMaterialState: () => ipcRenderer.invoke(DESKTOP_SIDEBAR_MATERIAL_STATE_CHANNEL),
  onSidebarMaterialChanged: (listener: (state: DesktopSidebarMaterialState) => void) => {
    if (typeof listener !== "function") return () => {};
    const handleChange = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isSidebarMaterialState(value)) listener({ status: value.status });
    };
    ipcRenderer.on(DESKTOP_SIDEBAR_MATERIAL_CHANGED_CHANNEL, handleChange);
    return () => ipcRenderer.removeListener(DESKTOP_SIDEBAR_MATERIAL_CHANGED_CHANNEL, handleChange);
  },
  getNativeServerState: () => ipcRenderer.invoke("openbot:native-server-state"),
  installNativeServer: () => ipcRenderer.invoke("openbot:install-native-server"),
  getConnectionState: () => ipcRenderer.invoke(DESKTOP_CONNECTION_STATE_CHANNEL),
  configureServer: (serverUrl: string) => {
    if (typeof serverUrl !== "string" || serverUrl.length === 0 || serverUrl.length > 2_048) {
      return Promise.resolve({ status: "failed", code: "invalid_url" });
    }
    return ipcRenderer.invoke(DESKTOP_CONFIGURE_SERVER_CHANNEL, serverUrl);
  },
  getSetupPlanState: () => ipcRenderer.invoke(DESKTOP_SETUP_PLAN_STATE_CHANNEL),
  saveSetupPlan: (plan: Parameters<OpenBotDesktopBridge["saveSetupPlan"]>[0]) => {
    if (!isBoundedSetupPlanInput(plan)) {
      return Promise.resolve({ status: "failed", code: "invalid_plan" });
    }
    return ipcRenderer.invoke(DESKTOP_SAVE_SETUP_PLAN_CHANNEL, plan);
  },
  getLocalWorkerState: () => ipcRenderer.invoke(DESKTOP_LOCAL_WORKER_STATE_CHANNEL),
  setupLocalWorker: (nodeId: string) => {
    if (!isBoundedNodeId(nodeId)) {
      return Promise.resolve({ status: "failed", code: "invalid_node_id" });
    }
    return ipcRenderer.invoke(DESKTOP_SETUP_LOCAL_WORKER_CHANNEL, nodeId);
  },
  enableLocalWorker: () => ipcRenderer.invoke(DESKTOP_ENABLE_LOCAL_WORKER_CHANNEL),
  openLocalWorkerSettings: () => ipcRenderer.invoke(DESKTOP_OPEN_LOCAL_WORKER_SETTINGS_CHANNEL),
});

contextBridge.exposeInMainWorld("openbotDesktop", bridge);

function isBoundedSetupPlanInput(
  input: unknown,
): input is Parameters<OpenBotDesktopBridge["saveSetupPlan"]>[0] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  return (
    keys.length === 3 &&
    keys[0] === "localWorker" &&
    keys[1] === "mode" &&
    keys[2] === "plannedWorkerCount" &&
    typeof value.localWorker === "boolean" &&
    ["client", "client-worker", "host", "advanced"].includes(String(value.mode)) &&
    Number.isInteger(value.plannedWorkerCount) &&
    Number(value.plannedWorkerCount) >= 0 &&
    Number(value.plannedWorkerCount) <= 100
  );
}

function isBoundedNodeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function isSidebarMaterialState(value: unknown): value is DesktopSidebarMaterialState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    Object.keys(state).length === 1 &&
    typeof state.status === "string" &&
    ["enabled", "disabled", "reduced", "unsupported", "unavailable"].includes(state.status)
  );
}

function isNavigationCommand(value: unknown): value is DesktopNavigationCommand {
  return (
    typeof value === "string" &&
    [
      "new-conversation",
      "open-settings",
      "go-back",
      "go-forward",
      "toggle-sidebar",
      "toggle-details",
    ].includes(value)
  );
}

function isNavigationMenuState(value: unknown): value is DesktopNavigationMenuState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state);
  return (
    keys.length === 4 &&
    keys.every(
      (key) =>
        ["workspaceReady", "settingsAvailable", "canGoBack", "canGoForward"].includes(key) &&
        typeof state[key] === "boolean",
    )
  );
}

function isEmployeeTemplateSaveInput(value: unknown): value is EmployeeTemplateSaveInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
  return (
    (keys.length === 4 || keys.length === 5) &&
    (input.includeSkillContent === undefined || typeof input.includeSkillContent === "boolean") &&
    keys.every((key) =>
      ["botId", "packageId", "generatedAt", "downloadReviewToken", "includeSkillContent"].includes(
        key,
      ),
    ) &&
    typeof input.botId === "string" &&
    uuid.test(input.botId) &&
    typeof input.packageId === "string" &&
    uuid.test(input.packageId) &&
    typeof input.generatedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.generatedAt) &&
    Number.isFinite(Date.parse(input.generatedAt)) &&
    new Date(input.generatedAt).toISOString() === input.generatedAt &&
    typeof input.downloadReviewToken === "string" &&
    /^[a-f0-9]{64}$/u.test(input.downloadReviewToken)
  );
}
