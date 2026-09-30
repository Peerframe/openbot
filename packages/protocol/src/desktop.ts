/** Shared Desktop bridge data; runtime validation belongs to each trust boundary. */
export type DesktopSetupMode = "client" | "client-worker" | "host" | "advanced";
export interface DesktopSetupPlanInput {
  localWorker: boolean;
  mode: DesktopSetupMode;
  plannedWorkerCount: number;
}

export interface DesktopRuntimeInfo {
  kind: "desktop";
  platform: string;
  arch?: string;
  shellVersion: string;
}

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

export type DesktopLocalWorkerFailureCode =
  | "invalid_node_id"
  | "not_selected"
  | "unavailable"
  | "authentication_required"
  | "server_unavailable"
  | "already_configured"
  | "busy"
  | "native_failed";

export type DesktopLocalWorkerOperationResult =
  | Readonly<{ status: "succeeded"; state: DesktopLocalWorkerState }>
  | Readonly<{ status: "failed"; code: DesktopLocalWorkerFailureCode }>;

export type DesktopSidebarMaterialState = Readonly<{
  status: "enabled" | "disabled" | "reduced" | "unsupported" | "unavailable";
}>;

/**
 * A native notification request. Callers keep private content out: the text can appear on a
 * locked screen and in the OS notification history. Bounds follow the macOS body limit.
 */
export type DesktopNotificationInput = Readonly<{ title: string; body: string }>;
export type DesktopNotificationResult = Readonly<{
  status: "clicked" | "closed" | "expired" | "failed" | "unsupported";
}>;

export type DesktopNavigationCommand =
  | "new-conversation"
  | "open-settings"
  | "go-back"
  | "go-forward"
  | "toggle-sidebar"
  | "toggle-details";

export type DesktopNavigationMenuState = Readonly<{
  workspaceReady: boolean;
  settingsAvailable: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}>;

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
  showNotification?(input: DesktopNotificationInput): Promise<DesktopNotificationResult>;
  onSidebarMaterialChanged?(listener: (state: DesktopSidebarMaterialState) => void): () => void;
  getNativeServerState?(): Promise<NativeServerState>;
  installNativeServer?(): Promise<NativeServerState>;
  getRuntimeInfo(): DesktopRuntimeInfo;
  getConnectionState(): Promise<DesktopConnectionState>;
  configureServer(serverUrl: string): Promise<ConfigureDesktopServerResult>;
  getSetupPlanState(): Promise<DesktopSetupPlanState>;
  saveSetupPlan(plan: DesktopSetupPlanInput): Promise<SaveDesktopSetupPlanResult>;
  getLocalWorkerState(): Promise<DesktopLocalWorkerState>;
  setupLocalWorker(nodeId: string): Promise<DesktopLocalWorkerOperationResult>;
  enableLocalWorker(): Promise<DesktopLocalWorkerOperationResult>;
  openLocalWorkerSettings(): Promise<DesktopLocalWorkerOperationResult>;
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
