import type {
  ApprovalDecision,
  AuthSessionSnapshot,
  CreateBotInput,
  CreateChannelInput,
  EmployeeProfile,
  RunFrame,
  WorkspaceSnapshot,
} from "@openbot/domain";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  createBot,
  createChannel,
  decideApproval,
  getAuthSession,
  getEmployeeProfile,
  getModelSettings,
  getWorkspace,
  joinBotToChannel,
  login,
  logout,
  openBotConversation,
  type RealtimeConnectionState,
  removeChannelMember,
  subscribeToUnauthorized,
  subscribeToWorkspaceEvents,
} from "./api";
import { resolveAuthSession } from "./auth-session-recovery";
import { AutomationsScreen } from "./components/AutomationsScreen";
import { ChannelMembersMenu } from "./components/ChannelMembersMenu";
import { ChannelWorkspace } from "./components/ChannelWorkspace";
import { ContextRail } from "./components/ContextRail";
import { CreateBotDialog } from "./components/CreateBotDialog";
import { CreateChannelDialog } from "./components/CreateChannelDialog";
import { DesktopConnectionScreen } from "./components/DesktopConnectionScreen";
import { DesktopInstallScreen } from "./components/DesktopInstallScreen";
import { DesktopLocalWorkerScreen } from "./components/DesktopLocalWorkerScreen";
import { DesktopSettingsScreen } from "./components/DesktopSettingsScreen";
import { DesktopSetupScreen } from "./components/DesktopSetupScreen";
import { EmployeeBrowser } from "./components/EmployeeBrowser";
import { EmployeeProfileRail } from "./components/EmployeeProfileRail";
import { EmployeeProfileView, type ProfileTab } from "./components/EmployeeProfileView";
import { ExportEmployeeDialog } from "./components/ExportEmployeeDialog";
import {
  BackIcon,
  ForwardIcon,
  HashIcon,
  NodeIcon,
  PanelLeftIcon,
  PanelRightIcon,
  ShareIcon,
} from "./components/Icons";
import { ImportEmployeeDialog } from "./components/ImportEmployeeDialog";
import { LoginScreen } from "./components/LoginScreen";
import { MobileNavigation, type MobilePanel } from "./components/MobileNavigation";
import { ModelConnectionsDialog } from "./components/ModelConnectionsDialog";
import { ModelSettingsScreen } from "./components/ModelSettingsScreen";
import { NodeManagerDialog } from "./components/NodeManagerDialog";
import { OpenBotMark } from "./components/OpenBotMark";
import { indexRunCollaboration } from "./components/RunCollaboration";
import { RunInspector } from "./components/RunInspector";
import { ShareConversationDialog } from "./components/ShareConversationDialog";
import { Sidebar } from "./components/Sidebar";
import { SkillLibraryScreen } from "./components/SkillLibraryScreen";
import { parseWorkEntry, WorkTasksEntry } from "./components/WorkTasksEntry";
import { WorkTasksScreen } from "./components/WorkTasksScreen";
import { createConversationSession } from "./conversation-session";
import {
  type DesktopConnectionState,
  type DesktopLocalWorkerState,
  type DesktopSetupPlanState,
  getOpenBotDesktopBridge,
} from "./desktop-runtime";
import { shortcutLabel } from "./desktop-shortcuts";
import { useDesktopNavigation } from "./use-desktop-navigation";
import { useWorkspaceAppearance } from "./use-workspace-appearance";
import { useWorkspaceState } from "./use-workspace-state";
import { useWorkspaceNavigation } from "./workspace-navigation";
import { updatePreferences, useWorkspacePreferences } from "./workspace-preferences";

type Dialog = "bot" | "channel" | "node" | undefined;

export function App() {
  const [workEntry, setWorkEntry] = useState(() => parseWorkEntry(window.location.hash));
  useEffect(() => {
    const update = () => setWorkEntry(parseWorkEntry(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const material = useWorkspaceAppearance();
  const desktopBridge = getOpenBotDesktopBridge();
  const [desktopConnection, setDesktopConnection] = useState<
    DesktopConnectionState | null | undefined
  >(() => (desktopBridge === undefined ? null : undefined));
  const [desktopSetupPlan, setDesktopSetupPlan] = useState<
    DesktopSetupPlanState | null | undefined
  >(() => (desktopBridge === undefined ? null : undefined));
  const [nativeReady, setNativeReady] = useState(false);
  const [modelChecked, setModelChecked] = useState(false);
  const [showModelSetup, setShowModelSetup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "about" | "automations">(
    "general",
  );
  const [settingsError, setSettingsError] = useState<string>();
  const [showNodeSettings, setShowNodeSettings] = useState(false);
  const [settingsNodes, setSettingsNodes] = useState<WorkspaceSnapshot["nodes"]>([]);
  const [showConnectionSetup, setShowConnectionSetup] = useState(false);
  const [showSetupPlan, setShowSetupPlan] = useState(false);
  const [desktopLocalWorker, setDesktopLocalWorker] = useState<
    DesktopLocalWorkerState | null | undefined
  >(() => (desktopBridge === undefined ? null : undefined));
  const [skipLocalWorkerSetup, setSkipLocalWorkerSetup] = useState(false);
  const [session, setSession] = useState<AuthSessionSnapshot>();
  const [sessionError, setSessionError] = useState<string>();

  const localHost =
    desktopSetupPlan?.status === "configured" && desktopSetupPlan.plan.mode === "host";
  const restoreLocalSession =
    localHost && nativeReady ? desktopBridge?.restoreLocalSession : undefined;
  const authRequest = useRef(0);
  const explicitlyLoggedOut = useRef(false);
  const refreshSession = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = ++authRequest.current;
      setSessionError(undefined);
      try {
        const next = await resolveAuthSession(getAuthSession, restoreLocalSession, signal);
        if (!signal?.aborted && requestId === authRequest.current) setSession(next);
      } catch (cause) {
        if (signal?.aborted || requestId !== authRequest.current) return;
        setSession(undefined);
        setSessionError(
          cause instanceof Error ? cause.message : "无法连接 OpenBot Server。请确认服务已启动。",
        );
      }
    },
    [restoreLocalSession],
  );

  useEffect(() => {
    if (desktopBridge === undefined) return;
    let active = true;
    void desktopBridge
      .getConnectionState()
      .then((connection) => {
        if (active) setDesktopConnection(connection);
      })
      .catch(() => {
        if (active) setDesktopConnection({ status: "invalid" });
      });
    return () => {
      active = false;
    };
  }, [desktopBridge]);

  useEffect(() => {
    if (desktopBridge === undefined) return;
    let active = true;
    void desktopBridge
      .getSetupPlanState()
      .then((plan) => {
        if (active) setDesktopSetupPlan(plan);
      })
      .catch(() => {
        if (active) setDesktopSetupPlan({ status: "invalid" });
      });
    return () => {
      active = false;
    };
  }, [desktopBridge]);

  const setupPlanReady = desktopSetupPlan === null || desktopSetupPlan?.status === "configured";
  const connectionReady =
    setupPlanReady &&
    (desktopSetupPlan?.status !== "configured" ||
      desktopSetupPlan.plan.mode !== "host" ||
      nativeReady) &&
    (desktopConnection === null || desktopConnection?.status === "configured");

  useEffect(() => {
    if (!connectionReady) return;
    const controller = new AbortController();
    void refreshSession(controller.signal);
    return () => controller.abort();
  }, [connectionReady, refreshSession]);

  useEffect(() => {
    if (!nativeReady || session?.authenticated !== true || modelChecked) return;
    let active = true;
    void getModelSettings()
      .then((model) => {
        if (!active) return;
        setModelChecked(true);
        if (model.status !== "configured") setShowModelSetup(true);
      })
      .catch(() => {
        if (active) {
          setModelChecked(true);
          setShowModelSetup(true);
        }
      });
    return () => {
      active = false;
    };
  }, [nativeReady, session, modelChecked]);

  useEffect(
    () =>
      subscribeToUnauthorized(() => {
        if (explicitlyLoggedOut.current) return;
        if (restoreLocalSession) void refreshSession();
        else setSession({ authenticated: false });
      }),
    [refreshSession, restoreLocalSession],
  );

  useEffect(() => {
    if (!restoreLocalSession) return;
    const foreground = () => {
      if (document.visibilityState === "visible" && !explicitlyLoggedOut.current)
        void refreshSession();
    };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [refreshSession, restoreLocalSession]);

  useEffect(() => {
    if (
      desktopBridge === undefined ||
      desktopSetupPlan?.status !== "configured" ||
      !desktopSetupPlan.plan.localWorker
    ) {
      setDesktopLocalWorker(null);
      return;
    }
    if (session?.authenticated !== true) {
      setDesktopLocalWorker(undefined);
      return;
    }
    let active = true;
    void desktopBridge
      .getLocalWorkerState()
      .then((state) => {
        if (active) setDesktopLocalWorker(state);
      })
      .catch(() => {
        if (active) setDesktopLocalWorker({ status: "invalid" });
      });
    return () => {
      active = false;
    };
  }, [desktopBridge, desktopSetupPlan, session]);

  useEffect(() => {
    if (session?.authenticated !== true) return;
    const remainingMs = new Date(session.expiresAt).getTime() - Date.now();
    const timer = window.setTimeout(
      () => {
        if (explicitlyLoggedOut.current) return;
        if (restoreLocalSession) void refreshSession();
        else setSession({ authenticated: false });
      },
      Math.max(1000, Math.min(remainingMs, 2_147_483_647)),
    );
    return () => window.clearTimeout(timer);
  }, [session, refreshSession, restoreLocalSession]);

  if (
    desktopBridge !== undefined &&
    (desktopConnection === undefined || desktopSetupPlan === undefined)
  ) {
    return (
      <main className="loading-screen">
        <OpenBotMark className="onboarding-mark" />
        <h1>正在读取 Desktop 配置</h1>
        <p>正在打开你的本地安装计划和连接设置…</p>
      </main>
    );
  }

  if (
    desktopBridge !== undefined &&
    desktopSetupPlan !== undefined &&
    desktopSetupPlan !== null &&
    (showSetupPlan ||
      desktopSetupPlan.status !== "configured" ||
      (desktopSetupPlan.plan.mode === "host" &&
        !(
          desktopBridge.getRuntimeInfo?.().platform === "darwin" &&
          desktopBridge.getRuntimeInfo?.().arch === "arm64"
        )))
  ) {
    return (
      <DesktopSetupScreen
        state={desktopSetupPlan}
        platform={desktopBridge.getRuntimeInfo?.().platform}
        arch={desktopBridge.getRuntimeInfo?.().arch}
        onCancel={showSettings ? () => setShowSetupPlan(false) : undefined}
        onSave={async (plan) => {
          const result = await desktopBridge.saveSetupPlan(plan);
          if (result.status === "configured") {
            const wasHost =
              desktopSetupPlan?.status === "configured" && desktopSetupPlan.plan.mode === "host";
            setDesktopSetupPlan(result);
            if (wasHost && plan.mode !== "host") {
              setNativeReady(false);
              setDesktopConnection({ status: "unconfigured" });
              setSession(undefined);
            }
            if (plan.mode === "host" && !wasHost) {
              setNativeReady(false);
              setModelChecked(false);
            }
            setShowConnectionSetup(plan.mode === "client");
            setShowSettings(false);
            setSkipLocalWorkerSetup(false);
            setShowSetupPlan(false);
          }
          return result;
        }}
      />
    );
  }

  if (
    desktopBridge !== undefined &&
    desktopSetupPlan?.status === "configured" &&
    desktopSetupPlan.plan.mode === "host" &&
    !nativeReady
  ) {
    return (
      <DesktopInstallScreen
        bridge={desktopBridge}
        onBack={() => setShowSetupPlan(true)}
        onReady={(serverUrl) => {
          setDesktopConnection({ status: "configured", serverUrl });
          setNativeReady(true);
          setSession(undefined);
          setSessionError(undefined);
        }}
      />
    );
  }

  if (
    desktopBridge !== undefined &&
    desktopConnection !== undefined &&
    desktopConnection !== null &&
    (showConnectionSetup || desktopConnection.status !== "configured")
  ) {
    return (
      <DesktopConnectionScreen
        canCancel={showConnectionSetup && desktopConnection.status === "configured"}
        connection={desktopConnection}
        onCancel={() => setShowConnectionSetup(false)}
        onConfigure={async (serverUrl) => {
          const result = await desktopBridge.configureServer(serverUrl);
          if (result.status === "configured") {
            setSession(undefined);
            setSessionError(undefined);
            setDesktopConnection(result);
            setShowConnectionSetup(false);
            await refreshSession();
          }
          return result;
        }}
        onChangePlan={() => setShowSetupPlan(true)}
        setupPlan={desktopSetupPlan?.status === "configured" ? desktopSetupPlan.plan : undefined}
      />
    );
  }

  if (session === undefined) {
    return (
      <main className="loading-screen">
        <OpenBotMark className="onboarding-mark" />
        <h1>{sessionError ? "无法打开 OpenBot" : "正在验证本地会话"}</h1>
        <p>{sessionError ?? "正在安全连接你的 OpenBot Server…"}</p>
        {sessionError ? (
          <div className="loading-actions">
            <button className="primary-button" type="button" onClick={() => refreshSession()}>
              重新连接
            </button>
            {desktopBridge !== undefined ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => setShowConnectionSetup(true)}
              >
                更换 Server
              </button>
            ) : null}
          </div>
        ) : null}
      </main>
    );
  }

  if (!session.authenticated && localHost) {
    return (
      <main className="login-screen">
        <section className="login-card" aria-labelledby="local-session-title">
          <OpenBotMark />
          <h1 id="local-session-title">已退出本机工作区</h1>
          <p className="login-copy">由这台电脑验证身份，无需输入密码。</p>
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              explicitlyLoggedOut.current = false;
              setSession(undefined);
              void refreshSession();
            }}
          >
            重新进入
          </button>
        </section>
      </main>
    );
  }

  if (!session.authenticated) {
    return <LoginScreen onLogin={async (password) => setSession(await login(password))} />;
  }

  if (workEntry)
    return (
      <WorkTasksEntry
        initialTaskId={workEntry.taskId}
        key={`${session.owner.id}:${desktopConnection?.status === "configured" ? desktopConnection.serverUrl : "web"}`}
        onLogout={async () => {
          explicitlyLoggedOut.current = true;
          ++authRequest.current;
          try {
            await logout();
          } catch (error) {
            explicitlyLoggedOut.current = false;
            throw error;
          }
          setSession({ authenticated: false });
        }}
      />
    );

  if (nativeReady && !modelChecked)
    return (
      <main className="loading-screen">
        <OpenBotMark className="onboarding-mark" />
        <h1>正在读取模型配置</h1>
      </main>
    );

  if (showModelSetup)
    return (
      <ModelSettingsScreen
        onboarding={!showSettings}
        onDone={() => {
          setShowModelSetup(false);
          setModelChecked(true);
        }}
      />
    );

  const settingsPanel =
    showSettings && desktopSetupPlan?.status === "configured" ? (
      <>
        <DesktopSettingsScreen
          initialSection={settingsSection}
          error={settingsError}
          plan={desktopSetupPlan.plan}
          material={material}
          connection={desktopConnection}
          localWorker={desktopLocalWorker}
          onConnection={() => setShowConnectionSetup(true)}
          onRole={() => setShowSetupPlan(true)}
          onBack={() => setShowSettings(false)}
          onWorker={() => {
            void getWorkspace()
              .then((workspace) => {
                setSettingsNodes(workspace.nodes);
                setShowNodeSettings(true);
                setSettingsError(undefined);
              })
              .catch(() => setSettingsError("无法读取工作电脑，请检查连接后重试。"));
          }}
        />
        {showNodeSettings ? (
          <NodeManagerDialog
            onlineNodes={settingsNodes}
            onClose={() => setShowNodeSettings(false)}
          />
        ) : null}
      </>
    ) : showSettings && !desktopBridge ? (
      <ModelSettingsScreen onDone={() => setShowSettings(false)} />
    ) : null;

  if (
    desktopBridge !== undefined &&
    desktopSetupPlan?.status === "configured" &&
    desktopSetupPlan.plan.localWorker &&
    !skipLocalWorkerSetup
  ) {
    if (desktopLocalWorker === undefined || desktopLocalWorker === null) {
      return (
        <main className="loading-screen">
          <OpenBotMark className="onboarding-mark" />
          <h1>正在检查本机 Worker</h1>
          <p>正在读取原生组件、身份与 macOS 后台项目的真实状态…</p>
        </main>
      );
    }
    if (desktopLocalWorker.status !== "enabled") {
      return (
        <DesktopLocalWorkerScreen
          state={desktopLocalWorker}
          onContinue={() => setSkipLocalWorkerSetup(true)}
          onSetup={async (nodeId) => {
            const result = await desktopBridge.setupLocalWorker(nodeId);
            if (result.status === "succeeded") setDesktopLocalWorker(result.state);
            return result;
          }}
          onEnable={async () => {
            const result = await desktopBridge.enableLocalWorker();
            if (result.status === "succeeded") setDesktopLocalWorker(result.state);
            return result;
          }}
          onOpenSettings={async () => {
            const result = await desktopBridge.openLocalWorkerSettings();
            if (result.status === "succeeded") setDesktopLocalWorker(result.state);
            return result;
          }}
          onRefresh={async () => {
            const state = await desktopBridge.getLocalWorkerState();
            setDesktopLocalWorker(state);
            return state;
          }}
        />
      );
    }
  }

  return (
    <>
      <div className="workspace-preserved" hidden={showSettings} inert={showSettings}>
        <AuthenticatedWorkspace
          key={`${session.owner.id}:${desktopConnection?.status === "configured" ? desktopConnection.serverUrl : "web"}`}
          active={!showSettings}
          ownerName={session.owner.name}
          onSettings={(section = "general") => {
            setSettingsSection(section);
            setShowSettings(true);
          }}
          onLogout={async () => {
            explicitlyLoggedOut.current = true;
            ++authRequest.current;
            try {
              await logout();
            } catch (error) {
              explicitlyLoggedOut.current = false;
              throw error;
            }
            setSession({ authenticated: false });
          }}
        />
      </div>
      {settingsPanel}
    </>
  );
}

export function AuthenticatedWorkspace({
  active = true,
  onSettings,
  ownerName,
  onLogout,
}: {
  active?: boolean;
  ownerName: string;
  onSettings?: ((section?: "general" | "about" | "automations") => void) | undefined;
  onLogout(): Promise<void>;
}) {
  const { values: preferences } = useWorkspacePreferences();
  const showDetails = preferences.rightPanelOpen;
  const navigation = useWorkspaceNavigation();
  const location = navigation.location;
  const destination =
    location.kind === "automations" || location.kind === "skills" || location.kind === "work"
      ? location.kind
      : "chat";
  const selectedChannelId = location.kind === "channel" ? location.id : undefined;
  const selectedEmployeeId = location.kind === "employee" ? location.id : undefined;
  const employeeInitialTab = location.kind === "employee" ? location.tab : "overview";
  const [conversationSession] = useState(createConversationSession);
  const [focusRequest, setFocusRequest] = useState(0);
  const sessionLifetime = useRef(0);
  useEffect(() => {
    const generation = ++sessionLifetime.current;
    return () => {
      queueMicrotask(() => {
        if (sessionLifetime.current === generation) conversationSession.dispose();
      });
    };
  }, [conversationSession]);
  const [dialog, setDialog] = useState<Dialog>();
  const [browserBotId, setBrowserBotId] = useState<string>();
  const [modelServicesOpen, setModelServicesOpen] = useState(false);
  const [modelServicesVersion, setModelServicesVersion] = useState(0);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>();
  const [error, setError] = useState<string>();
  const {
    workspace,
    refresh,
    projectChannel,
    projectBot,
    projectRun,
    projectProgress,
    projectNodes,
    projectNode,
    removeNode,
    projectApproval,
  } = useWorkspaceState(setError);
  const [notice, setNotice] = useState<string>();
  const [sharing, setSharing] = useState(false);
  const [sharedBotId, setSharedBotId] = useState<string>();
  const directRequest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: leaving a view invalidates an in-flight direct-conversation open.
  useEffect(
    () => () => {
      directRequest.current += 1;
    },
    [location, active],
  );
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [employeeProfile, setEmployeeProfile] = useState<EmployeeProfile>();
  const [employeeProfileLoading, setEmployeeProfileLoading] = useState(false);
  const [employeeProfileError, setEmployeeProfileError] = useState<string>();
  const selectedEmployeeIdRef = useRef<string | undefined>(undefined);
  const [employeeExportOpen, setEmployeeExportOpen] = useState(false);
  const [employeeImportOpen, setEmployeeImportOpen] = useState(false);
  const [framesByRun, setFramesByRun] = useState<Map<string, RunFrame>>(() => new Map());
  const [workspaceRealtimeState, setWorkspaceRealtimeState] =
    useState<RealtimeConnectionState>("connecting");
  const closeInspector = useCallback(() => setSelectedRunId(undefined), []);

  const projectFrame = useCallback((frame: RunFrame) => {
    setFramesByRun((current) => {
      const previous = current.get(frame.runId);
      if (previous !== undefined && previous.revision >= frame.revision) return current;
      const next = new Map(current);
      next.delete(frame.runId);
      next.set(frame.runId, frame);
      if (next.size > 50) {
        const oldest = next.keys().next().value as string | undefined;
        if (oldest !== undefined) next.delete(oldest);
      }
      return next;
    });
  }, []);

  const loadEmployeeProfile = useCallback(async (botId: string, signal?: AbortSignal) => {
    setEmployeeProfileLoading(true);
    setEmployeeProfileError(undefined);
    try {
      const profile = await getEmployeeProfile(botId, signal);
      if (!signal?.aborted && selectedEmployeeIdRef.current === botId) setEmployeeProfile(profile);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (selectedEmployeeIdRef.current === botId)
        setEmployeeProfileError(cause instanceof Error ? cause.message : "无法读取员工档案。");
    } finally {
      if (!signal?.aborted && selectedEmployeeIdRef.current === botId)
        setEmployeeProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    selectedEmployeeIdRef.current = selectedEmployeeId;
    if (selectedEmployeeId === undefined) {
      setEmployeeProfile(undefined);
      setEmployeeProfileError(undefined);
      setEmployeeProfileLoading(false);
      return;
    }
    const controller = new AbortController();
    setEmployeeProfile(undefined);
    void loadEmployeeProfile(selectedEmployeeId, controller.signal);
    return () => controller.abort();
  }, [loadEmployeeProfile, selectedEmployeeId]);

  const workspaceReady = workspace !== undefined;
  useEffect(() => {
    if (!workspace) return;
    if (location.kind === "home" && workspace.channels[0]) {
      navigation.replace({ kind: "channel", id: workspace.channels[0].id });
    } else if (
      location.kind === "channel" &&
      !workspace.channels.some((channel) => channel.id === location.id)
    ) {
      navigation.replace(
        workspace.channels[0]
          ? { kind: "channel", id: workspace.channels[0].id }
          : { kind: "home" },
      );
    } else if (
      location.kind === "employee" &&
      !workspace.bots.some((bot) => bot.id === location.id)
    ) {
      navigation.replace({ kind: "home" });
    }
  }, [workspace, location, navigation.replace]);

  useDesktopNavigation({
    active:
      active &&
      workspaceReady &&
      !dialog &&
      !selectedRunId &&
      !employeeImportOpen &&
      !employeeExportOpen &&
      !sharing &&
      !sharedBotId,
    settingsAvailable:
      active &&
      onSettings !== undefined &&
      !dialog &&
      !selectedRunId &&
      !employeeImportOpen &&
      !employeeExportOpen &&
      !sharing &&
      !sharedBotId,
    canGoBack: navigation.canGoBack,
    canGoForward: navigation.canGoForward,
    onBack: navigation.back,
    onForward: navigation.forward,
    onNewConversation: () => setDialog("channel"),
    onSettings,
  });

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (focusRequest > 0)
        document
          .querySelector<HTMLTextAreaElement>('[aria-label="消息内容"]')
          ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, focusRequest]);

  useEffect(() => {
    if (!workspaceReady) return;
    return subscribeToWorkspaceEvents({
      onReady(nodes) {
        projectNodes(nodes);
        // Reconcile any events missed while the browser was disconnected.
        void refresh();
        const selectedEmployee = selectedEmployeeIdRef.current;
        if (selectedEmployee !== undefined) void loadEmployeeProfile(selectedEmployee);
      },
      onEmployeeProfileChanged(botId, sections) {
        if (sections.includes("identity")) void refresh();
        if (selectedEmployeeIdRef.current === botId) void loadEmployeeProfile(botId);
      },
      onNode: projectNode,
      onNodeRemoved: removeNode,
      onApproval: projectApproval,
      onRun: projectRun,
      onState: setWorkspaceRealtimeState,
    });
  }, [
    loadEmployeeProfile,
    projectRun,
    projectNodes,
    projectNode,
    removeNode,
    projectApproval,
    refresh,
    workspaceReady,
  ]);

  async function handleCreateBot(input: CreateBotInput) {
    const bot = await createBot(input);
    projectBot(bot);
    await refresh();
    setDialog(undefined);
    showNotice(`${bot.name} 已创建。`);
  }

  async function handleCreateChannel(input: CreateChannelInput) {
    const channel = await createChannel(input);
    projectChannel(channel);
    await refresh();
    selectChannel(channel.id);
    setFocusRequest((value) => value + 1);
    setDialog(undefined);
    setMobilePanel(undefined);
    showNotice(`${channel.name} 已创建。`);
  }

  async function handleJoinBot(botId: string) {
    if (selectedChannelId === undefined) return;
    const channel = await joinBotToChannel(selectedChannelId, botId);
    projectChannel(channel);
    await refresh();
    showNotice("Bot 已加入频道。");
  }

  async function handleRemoveBot(botId: string) {
    if (!selectedChannelId) return;
    const result = await removeChannelMember(selectedChannelId, botId);
    projectChannel(result.channel);
    for (const run of result.cancelledRuns) projectRun(run);
    await refresh();
    showNotice("Bot 已移出频道，相关活动任务已停止，历史记录已保留。");
  }

  async function handleDecideApproval(approvalId: string, decision: ApprovalDecision) {
    const resolution = await decideApproval(approvalId, decision);
    projectApproval(resolution.approval, resolution.run);
    showNotice(decision === "approve" ? "已批准一次。" : "已拒绝该动作。");
  }

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(undefined), 3000);
  }

  function selectChannel(channelId: string) {
    directRequest.current += 1;
    navigation.navigate({ kind: "channel", id: channelId });
    setEmployeeExportOpen(false);
    setEmployeeImportOpen(false);
    setSelectedRunId(undefined);
    setMobilePanel(undefined);
  }

  function openEmployee(botId: string, initialTab: ProfileTab = "overview") {
    directRequest.current += 1;
    navigation.navigate({ kind: "employee", id: botId, tab: initialTab });
    setEmployeeExportOpen(false);
    setEmployeeImportOpen(false);
    setSelectedRunId(undefined);
    setMobilePanel(undefined);
  }

  async function openDirectConversation(botId: string) {
    const request = ++directRequest.current;
    try {
      const channel = await openBotConversation(botId);
      if (request !== directRequest.current) return;
      projectChannel(channel);
      selectChannel(channel.id);
    } catch (cause) {
      if (request === directRequest.current)
        setError(cause instanceof Error ? cause.message : "无法打开 Bot 对话，请重试。");
    }
  }

  function assignEmployee(botId: string) {
    const channel = workspace?.channels.find((item) => item.botIds.includes(botId));
    if (channel === undefined) {
      showNotice("请先把这名员工加入一个频道。");
      return;
    }
    selectChannel(channel.id);
  }

  if (workspace === undefined) {
    return (
      <main className="loading-screen">
        <OpenBotMark className="onboarding-mark" />
        <h1>{error ? "无法打开 OpenBot" : "正在连接 OpenBot"}</h1>
        <p>{error ?? "正在读取本地频道、Bots 与节点状态…"}</p>
        {error ? (
          <button className="primary-button" type="button" onClick={() => refresh()}>
            重新连接
          </button>
        ) : null}
        <a href="#/tasks">打开任务监督</a>
      </main>
    );
  }

  const selectedChannel = workspace.channels.find((channel) => channel.id === selectedChannelId);
  const fullPage = destination !== "chat";
  const selectedRun = workspace.runs.find((run) => run.id === selectedRunId);
  const panelToggle = (
    <button
      className="icon-button panel-toggle"
      type="button"
      aria-label={showDetails ? "收起信息栏" : "打开信息栏"}
      title={showDetails ? "收起信息栏" : "打开信息栏"}
      aria-expanded={showDetails}
      aria-controls="workspace-details"
      onClick={() => updatePreferences({ rightPanelOpen: !showDetails })}
    >
      <PanelRightIcon />
    </button>
  );

  return (
    <div
      className={`app-shell desktop-workspace ${error ? "workspace-refresh-failed" : ""} ${destination === "chat" && selectedChannel ? "channel-view" : ""} ${fullPage ? "full-page-destination" : ""} ${showDetails ? "" : "without-context"} ${preferences.leftPanelOpen ? "" : "without-sidebar"}`}
    >
      <header className="workspace-toolbar">
        <nav className="toolbar-navigation" aria-label="页面与侧栏导航">
          <button
            type="button"
            className="icon-button"
            aria-label={preferences.leftPanelOpen ? "收起侧栏" : "打开侧栏"}
            aria-expanded={preferences.leftPanelOpen}
            aria-controls="workspace-sidebar"
            title={`切换侧栏 · ${shortcutLabel("B")}`}
            onClick={() => updatePreferences({ leftPanelOpen: !preferences.leftPanelOpen })}
          >
            <PanelLeftIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="后退"
            title={`后退 · ${shortcutLabel("[")}`}
            disabled={!navigation.canGoBack}
            onClick={navigation.back}
          >
            <BackIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="前进"
            title={`前进 · ${shortcutLabel("]")}`}
            disabled={!navigation.canGoForward}
            onClick={navigation.forward}
          >
            <ForwardIcon />
          </button>
        </nav>
        <div className="toolbar-context">
          {selectedChannel ? (
            <ChannelMembersMenu
              key={selectedChannel.id}
              channel={selectedChannel}
              bots={workspace.bots}
              onJoin={handleJoinBot}
              onRemove={handleRemoveBot}
              onOpenBot={openEmployee}
              showTitle
            />
          ) : (
            <div className="toolbar-title">
              <HashIcon />
              <h1
                title={
                  destination === "work"
                    ? "任务监督"
                    : destination === "automations"
                      ? "自动任务"
                      : destination === "skills"
                        ? "技能广场"
                        : selectedEmployeeId
                          ? (employeeProfile?.employee.name ?? "Bot 档案")
                          : "频道聊天"
                }
              >
                {destination === "work"
                  ? "任务监督"
                  : destination === "automations"
                    ? "自动任务"
                    : destination === "skills"
                      ? "技能广场"
                      : selectedEmployeeId
                        ? (employeeProfile?.employee.name ?? "Bot 档案")
                        : "频道聊天"}
              </h1>
            </div>
          )}
        </div>
        <div className="toolbar-layout">
          {selectedChannel && (
            <button
              className="icon-button"
              type="button"
              aria-label="分享"
              title="分享"
              onClick={() => setSharing(true)}
            >
              <ShareIcon />
            </button>
          )}
          <button
            className="icon-button"
            type="button"
            aria-label="工作电脑"
            title="工作电脑"
            onClick={() => setDialog("node")}
          >
            <NodeIcon />
          </button>
          {panelToggle}
        </div>
      </header>
      {error ? (
        <div className="workspace-refresh-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()}>
            重新连接
          </button>
        </div>
      ) : null}
      <div id="workspace-sidebar" className="workspace-sidebar" hidden={!preferences.leftPanelOpen}>
        <Sidebar
          onHome={() => navigation.navigate({ kind: "home" })}
          bots={workspace.bots}
          channels={workspace.channels.filter((channel) => !channel.directBotId)}
          runs={workspace.runs}
          ownerName={ownerName}
          destination={destination}
          onAutomations={() =>
            onSettings ? onSettings("automations") : navigation.navigate({ kind: "automations" })
          }
          onWork={() => navigation.navigate({ kind: "work" })}
          onSkills={() => navigation.navigate({ kind: "skills" })}
          selectedChannelId={destination === "chat" ? selectedChannel?.id : undefined}
          selectedBotId={
            destination === "chat"
              ? (selectedEmployeeId ?? selectedChannel?.directBotId)
              : undefined
          }
          onSelectChannel={selectChannel}
          onSelectBot={(botId) => void openDirectConversation(botId)}
          onOpenBotProfile={openEmployee}
          onCreateBot={() => setDialog("bot")}
          onCreateChannel={() => setDialog("channel")}
          onManageNodes={() => setDialog("node")}
          onManageModels={() => setModelServicesOpen(true)}
          onLogout={onLogout}
          onSettings={onSettings}
        />
      </div>

      <WorkTasksScreen
        bots={workspace.bots}
        active={destination === "work" && active}
        nativeCapabilitiesEnabled
      />
      {destination === "work" ? null : destination === "automations" ? (
        <AutomationsScreen bots={workspace.bots} channels={workspace.channels} />
      ) : destination === "skills" ? (
        <SkillLibraryScreen
          channels={workspace.channels}
          onInsertMaterial={(channelId, botId, text) => {
            const conversation = conversationSession.channel(channelId, botId);
            const draft = conversation.getSnapshot().draft;
            const next = [draft.text, text].filter(Boolean).join("\n\n");
            if (next.length > 8000)
              throw new Error("资料超过草稿剩余容量，请先缩短草稿或复制需要的片段。");
            conversation.edit({ text: next, targetBotId: botId, targetBotIds: [botId] });
            selectChannel(channelId);
          }}
          onBack={navigation.back}
          onCreateBot={() => setDialog("bot")}
          onImportBot={() => setEmployeeImportOpen(true)}
          bots={workspace.bots}
          onOpenBot={(botId) => openEmployee(botId, "skills")}
        />
      ) : selectedEmployeeId ? (
        <EmployeeProfileView
          key={`${selectedEmployeeId}:${employeeInitialTab}`}
          initialTab={employeeInitialTab}
          profile={employeeProfile}
          loading={employeeProfileLoading}
          error={employeeProfileError}
          onRetry={() => void loadEmployeeProfile(selectedEmployeeId)}
          onAssign={() => assignEmployee(selectedEmployeeId)}
          onExport={() => setEmployeeExportOpen(true)}
          onProfileChanged={() => loadEmployeeProfile(selectedEmployeeId)}
          onManageModels={() => setModelServicesOpen(true)}
          modelServicesVersion={modelServicesVersion}
          onOpenBrowser={() => setBrowserBotId(selectedEmployeeId)}
        />
      ) : selectedChannel ? (
        <ChannelWorkspace
          key={selectedChannel.id}
          session={conversationSession}
          globalHeader
          channel={selectedChannel}
          bots={workspace.bots}
          artifacts={workspace.artifacts}
          progress={workspace.progress}
          onChannel={projectChannel}
          onJoin={handleJoinBot}
          onRemove={handleRemoveBot}
          onInspectRun={setSelectedRunId}
          onOpenBot={openEmployee}
          onFrame={projectFrame}
          onProgress={projectProgress}
          onRun={projectRun}
        />
      ) : (
        <ChannelEmptyState
          hasBots={workspace.bots.length > 0}
          onCreateBot={() => setDialog("bot")}
          onCreateChannel={() => setDialog("channel")}
        />
      )}

      <div id="workspace-details" className="workspace-details" hidden={!showDetails}>
        {showDetails &&
          (destination === "chat" && selectedEmployeeId ? (
            <EmployeeProfileRail profile={employeeProfile} nodes={workspace.nodes} />
          ) : (
            <ContextRail
              selectedChannelId={destination === "chat" ? selectedChannel?.id : undefined}
              realtimeState={workspaceRealtimeState}
              workspace={workspace}
              onDecideApproval={handleDecideApproval}
              onInspectRun={setSelectedRunId}
            />
          ))}
      </div>

      <MobileNavigation
        panel={mobilePanel}
        bots={workspace.bots}
        channels={workspace.channels}
        runs={workspace.runs}
        approvals={workspace.approvals}
        onPanel={setMobilePanel}
        onDecideApproval={handleDecideApproval}
        onCreateBot={() => {
          setMobilePanel(undefined);
          setDialog("bot");
        }}
        onCreateChannel={() => {
          setMobilePanel(undefined);
          setDialog("channel");
        }}
        onManageNodes={() => {
          setMobilePanel(undefined);
          setDialog("node");
        }}
        onManageModels={() => {
          setMobilePanel(undefined);
          setModelServicesOpen(true);
        }}
        onSelectChannel={selectChannel}
        onSelectBot={openEmployee}
      />

      {sharing && selectedChannel && (
        <ShareConversationDialog
          key={selectedChannel.id}
          channel={selectedChannel}
          bots={workspace.bots}
          artifacts={workspace.artifacts}
          runs={workspace.runs}
          onShareBot={(botId) => {
            setSharing(false);
            setSharedBotId(botId);
          }}
          onClose={() => setSharing(false)}
        />
      )}
      {selectedRun ? (
        <RunInspector
          artifacts={workspace.artifacts.filter((artifact) => artifact.runId === selectedRun.id)}
          bot={workspace.bots.find((bot) => bot.id === selectedRun.botId)}
          botsById={new Map(workspace.bots.map((bot) => [bot.id, bot]))}
          childRuns={
            selectedChannel
              ? (indexRunCollaboration(selectedChannel.id, workspace.runs, []).childrenByParent.get(
                  selectedRun.id,
                ) ?? [])
              : []
          }
          node={workspace.nodes.find((node) => node.id === selectedRun.nodeId)}
          progress={workspace.progress.filter((item) => item.runId === selectedRun.id)}
          liveFrame={framesByRun.get(selectedRun.id)}
          run={selectedRun}
          onOpenBrowser={() => {
            setBrowserBotId(selectedRun.botId);
            closeInspector();
          }}
          onClose={closeInspector}
          onInspectRun={setSelectedRunId}
          onRun={(run) => {
            projectRun(run);
            setSelectedRunId(run.id);
          }}
        />
      ) : null}

      {dialog === "bot" ? (
        <CreateBotDialog
          onClose={() => setDialog(undefined)}
          onCreate={handleCreateBot}
          onManageModels={() => setModelServicesOpen(true)}
          modelServicesVersion={modelServicesVersion}
          onImport={() => {
            setDialog(undefined);
            setEmployeeImportOpen(true);
          }}
        />
      ) : null}
      {dialog === "channel" ? (
        <CreateChannelDialog
          bots={workspace.bots}
          onClose={() => setDialog(undefined)}
          onCreate={handleCreateChannel}
        />
      ) : null}
      {dialog === "node" ? (
        <NodeManagerDialog onlineNodes={workspace.nodes} onClose={() => setDialog(undefined)} />
      ) : null}
      {browserBotId && workspace.bots.find((bot) => bot.id === browserBotId) ? (
        <EmployeeBrowser
          bot={workspace.bots.find((bot) => bot.id === browserBotId)!}
          onClose={() => setBrowserBotId(undefined)}
        />
      ) : null}
      {modelServicesOpen ? (
        <ModelConnectionsDialog
          onClose={() => setModelServicesOpen(false)}
          onChanged={() => setModelServicesVersion((version) => version + 1)}
        />
      ) : null}
      {sharedBotId && workspace.bots.find((bot) => bot.id === sharedBotId) ? (
        <ExportEmployeeDialog
          employee={workspace.bots.find((bot) => bot.id === sharedBotId)!}
          onClose={() => setSharedBotId(undefined)}
          onDownloaded={(fileName) => {
            setSharedBotId(undefined);
            showNotice(`已下载 Bot 模板：${fileName}`);
          }}
        />
      ) : null}
      {employeeExportOpen && employeeProfile ? (
        <ExportEmployeeDialog
          employee={employeeProfile.employee}
          onClose={() => setEmployeeExportOpen(false)}
          onDownloaded={(fileName) => {
            setEmployeeExportOpen(false);
            showNotice(`已下载安全员工模板：${fileName}`);
          }}
        />
      ) : null}
      {employeeImportOpen ? (
        <ImportEmployeeDialog
          onClose={() => setEmployeeImportOpen(false)}
          onActivated={(result) => {
            setEmployeeImportOpen(false);
            openEmployee(result.employee.id);
            void refresh();
            showNotice(
              result.replayed
                ? `${result.employee.name} 的导入结果已恢复。`
                : `${result.employee.name} 已激活，技能仍需逐项审核。`,
            );
          }}
        />
      ) : null}
      {!error && notice ? (
        <div className="toast" role="status">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

function ChannelEmptyState({
  headerAction,
  hasBots,
  onCreateBot,
  onCreateChannel,
}: {
  headerAction?: ReactNode;
  hasBots: boolean;
  onCreateBot(): void;
  onCreateChannel(): void;
}) {
  return (
    <main className="workspace-main channel-first-empty">
      <header className="empty-workspace-header">
        <span>频道聊天</span>
        <div className="workspace-header-actions">
          <span>OpenBot 工作空间</span>
          {headerAction}
        </div>
      </header>
      <section className="workspace-welcome" aria-labelledby="workspace-welcome-title">
        <OpenBotMark className="welcome-mark" />
        <h1 id="workspace-welcome-title">你的工作，从这里开始</h1>
        <p>
          为一件事建一个频道，和 Bot 一起完成。
          <br />
          对话、任务和结果，都留在这里。
        </p>
        <div>
          <button className="primary-button" type="button" onClick={onCreateChannel}>
            创建第一个频道
          </button>
          {!hasBots ? (
            <button className="secondary-button" type="button" onClick={onCreateBot}>
              先创建 Bot
            </button>
          ) : null}
        </div>
        <small className="welcome-note">从左侧选择频道，随时继续之前的工作。</small>
      </section>
    </main>
  );
}
