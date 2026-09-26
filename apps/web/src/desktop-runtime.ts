export type DesktopConnectionState =
  | Readonly<{ status: "unconfigured" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "configured"; serverUrl: string }>;

export type ConfigureDesktopServerResult =
  | Readonly<{ status: "configured"; serverUrl: string }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{
      status: "failed";
      code:
        | "invalid_url"
        | "server_unreachable"
        | "server_redirected"
        | "not_openbot_server"
        | "confirmation_unavailable"
        | "storage_unavailable";
    }>;

export type DesktopSetupMode = "client" | "client-worker" | "host" | "advanced";

export interface DesktopSetupPlanInput {
  localWorker: boolean;
  mode: DesktopSetupMode;
  plannedWorkerCount: number;
}

export type DesktopSetupPlanState =
  | Readonly<{ status: "unconfigured" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "configured"; plan: Readonly<DesktopSetupPlanInput> }>;

export type SaveDesktopSetupPlanResult =
  | Extract<DesktopSetupPlanState, { status: "configured" }>
  | Readonly<{ status: "failed"; code: "invalid_plan" | "storage_unavailable" }>;

export type DesktopLocalWorkerState = Readonly<{
  status:
    | "not-selected"
    | "unavailable"
    | "not-configured"
    | "disabled"
    | "requires-approval"
    | "enabled"
    | "invalid";
}>;

export type DesktopLocalWorkerOperationResult =
  | Readonly<{ status: "succeeded"; state: DesktopLocalWorkerState }>
  | Readonly<{
      status: "failed";
      code:
        | "invalid_node_id"
        | "not_selected"
        | "unavailable"
        | "authentication_required"
        | "server_unavailable"
        | "already_configured"
        | "busy"
        | "native_failed";
    }>;

export type DesktopSidebarMaterialState = Readonly<{
  status: "enabled" | "disabled" | "reduced" | "unsupported" | "unavailable";
}>;

export type DesktopNavigationCommand =
  | "new-conversation"
  | "open-settings"
  | "go-back"
  | "go-forward"
  | "toggle-sidebar"
  | "toggle-details";
export interface DesktopNavigationMenuState {
  workspaceReady: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  settingsAvailable: boolean;
}
export type EmployeeTemplateSaveInput = Readonly<{
  botId: string;
  packageId: string;
  generatedAt: string;
  downloadReviewToken: string;
  includeSkillContent?: boolean;
}>;
export type EmployeeTemplateSaveResult = Readonly<{
  status: "saved" | "cancelled" | "busy" | "unavailable" | "exists" | "changed";
}>;

export interface OpenBotDesktopBridge {
  beginVoiceCapture?(): Promise<boolean>;
  endVoiceCapture?(): Promise<void>;
  saveAttachment?(input: {
    channelId: string;
    attachmentId: string;
  }): Promise<Readonly<{ status: "saved" | "cancelled" | "busy" | "unavailable" | "exists" }>>;
  saveEmployeeTemplate?(input: EmployeeTemplateSaveInput): Promise<EmployeeTemplateSaveResult>;
  restoreLocalSession?(): Promise<Readonly<{ status: "restored" | "unavailable" }>>;
  saveReport?(
    artifactId: string,
  ): Promise<Readonly<{ status: "saved" | "cancelled" | "busy" | "unavailable" | "exists" }>>;
  onNavigationCommand?(listener: (command: DesktopNavigationCommand) => void): () => void;
  updateNavigationMenuState?(state: DesktopNavigationMenuState): Promise<void>;
  setSidebarTranslucency?(enabled: boolean): Promise<DesktopSidebarMaterialState>;
  getSidebarMaterialState?(): Promise<DesktopSidebarMaterialState>;
  onSidebarMaterialChanged?(listener: (state: DesktopSidebarMaterialState) => void): () => void;
  getNativeServerState?(): Promise<NativeServerState>;
  installNativeServer?(): Promise<NativeServerState>;
  getRuntimeInfo?(): Readonly<{
    kind: "desktop";
    platform: string;
    arch?: string;
    shellVersion: string;
  }>;
  getConnectionState(): Promise<DesktopConnectionState>;
  configureServer(serverUrl: string): Promise<ConfigureDesktopServerResult>;
  getSetupPlanState(): Promise<DesktopSetupPlanState>;
  saveSetupPlan(plan: DesktopSetupPlanInput): Promise<SaveDesktopSetupPlanResult>;
  getLocalWorkerState(): Promise<DesktopLocalWorkerState>;
  setupLocalWorker(nodeId: string): Promise<DesktopLocalWorkerOperationResult>;
  enableLocalWorker(): Promise<DesktopLocalWorkerOperationResult>;
  openLocalWorkerSettings(): Promise<DesktopLocalWorkerOperationResult>;
}

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

export type NativeServerState =
  | Readonly<{ status: "idle"; initialized?: boolean }>
  | Readonly<{
      status: "installing";
      mode?: "initialize" | "resume";
      step: "checking" | "credentials" | "database" | "server" | "connecting";
    }>
  | Readonly<{ status: "ready"; serverUrl: string }>
  | Readonly<{
      status: "failed";
      code:
        | "unsupported_platform"
        | "installation_failed"
        | "credential_unavailable"
        | "service_stopped"
        | "stopping";
    }>;
