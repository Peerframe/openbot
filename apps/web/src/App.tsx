import type {
  ApprovalDecision,
  AuthSessionSnapshot,
  Bot,
  Channel,
  ModelSelection,
  RunFrame,
} from "@openbot/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  createBot,
  createChannel,
  createMessage,
  decideApproval,
  deleteBot,
  deleteChannel,
  getAuthSession,
  getModelSettings,
  getOwnerPreferences,
  getUnreadCounts,
  joinBotToChannel,
  login,
  logout,
  markChannelRead,
  openBotConversation,
  type RealtimeConnectionState,
  removeChannelMember,
  renameBot,
  renameChannel,
  subscribeToUnauthorized,
  subscribeToWorkspaceEvents,
} from "./api";
import { resolveAuthSession } from "./auth-session-recovery";
import { BotInfoRail } from "./components/BotInfoRail";
import { ChannelWorkspace } from "./components/ChannelWorkspace";
import { ContextRail } from "./components/ContextRail";
import { DesktopConnectionScreen } from "./components/DesktopConnectionScreen";
import { DesktopInstallScreen } from "./components/DesktopInstallScreen";
import { DesktopLocalWorkerScreen } from "./components/DesktopLocalWorkerScreen";
import {
  DesktopSettingsScreen,
  type DesktopSettingsSection,
} from "./components/DesktopSettingsScreen";
import { DesktopSetupScreen } from "./components/DesktopSetupScreen";
import { EmployeeBrowser } from "./components/EmployeeBrowser";
import { EmployeeProfileView, type ProfileTab } from "./components/EmployeeProfileView";
import { EmptyWorkspace } from "./components/EmptyWorkspace";
import { ExportEmployeeDialog } from "./components/ExportEmployeeDialog";
import { ImportEmployeeDialog } from "./components/ImportEmployeeDialog";
import { LoginScreen } from "./components/LoginScreen";
import { MobileNavigation, type MobilePanel } from "./components/MobileNavigation";
import { ModelConnectionsDialog } from "./components/ModelConnectionsDialog";
import { ModelSettingsScreen } from "./components/ModelSettingsScreen";
import { NewChatScreen, type NewChatStart } from "./components/NewChatScreen";
import { NodeManagerDialog } from "./components/NodeManagerDialog";
import { LaunchExit, LaunchScreen, OnboardingFrame } from "./components/Onboarding";
import { PluginsDialog } from "./components/PluginsDialog";
import { indexRunCollaboration } from "./components/RunCollaboration";
import { ShareConversationDialog } from "./components/ShareConversationDialog";
import { Sidebar, type SidebarActivity } from "./components/Sidebar";
import { TaskSheet } from "./components/TaskSheet";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { parseWorkEntry, WorkTasksEntry } from "./components/WorkTasksEntry";
import { WorkTasksScreen } from "./components/WorkTasksScreen";
import { createConversationSession } from "./conversation-session";
import {
  type DesktopConnectionState,
  type DesktopLocalWorkerState,
  type DesktopSetupPlanState,
  getOpenBotDesktopBridge,
} from "./desktop-runtime";
import { freshAppearance, nextBotName, QUICK_BOT_ROLE } from "./quick-bot";
import { type SidebarItemKey, sidebarOrganization } from "./sidebar-organization";
import {
  NotificationTracker,
  type SystemNotice,
  showSystemNotification,
  windowIsAttended,
} from "./system-notifications";
import { useDesktopNavigation } from "./use-desktop-navigation";
import { useEmployeeProfile } from "./use-employee-profile";
import { useSettingsCounts } from "./use-settings-counts";
import { useWorkspaceAppearance } from "./use-workspace-appearance";
import { useWorkspaceState } from "./use-workspace-state";
import { useWorkspaceNavigation } from "./workspace-navigation";
import { updatePreferences, useWorkspacePreferences } from "./workspace-preferences";

type Dialog = "node" | undefined;

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
  const [settingsSection, setSettingsSection] = useState<DesktopSettingsSection>("general");
  const settingsCounts = useSettingsCounts(showSettings);
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
  async function logoutWorkspace() {
    explicitlyLoggedOut.current = true;
    ++authRequest.current;
    try {
      await logout();
    } catch (error) {
      explicitlyLoggedOut.current = false;
      throw error;
    }
    setSession({ authenticated: false });
  }

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
          cause instanceof Error ? cause.message : "无法连接 OpenBot 服务电脑。请确认服务已启动。",
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
    return <LaunchScreen status="正在读取这台电脑的设置" />;
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
      <LaunchScreen
        status="正在打开你的工作区"
        error={sessionError}
        actions={
          sessionError ? (
            <>
              <button className="ob-setup-primary" type="button" onClick={() => refreshSession()}>
                重新连接
              </button>
              {desktopBridge !== undefined ? (
                <button
                  className="ob-setup-secondary"
                  type="button"
                  onClick={() => setShowConnectionSetup(true)}
                >
                  更换服务电脑
                </button>
              ) : null}
            </>
          ) : undefined
        }
      />
    );
  }

  if (!session.authenticated && localHost) {
    return (
      <OnboardingFrame
        avatar={{ character: "round", accent: "green" }}
        title="已退出本机工作区"
        description="由这台电脑验证身份，无需输入密码。"
        width={380}
        offset={140}
        titleId="local-session-title"
      >
        <button
          className="ob-setup-primary"
          type="button"
          onClick={() => {
            explicitlyLoggedOut.current = false;
            setSession(undefined);
            void refreshSession();
          }}
        >
          重新进入
        </button>
      </OnboardingFrame>
    );
  }

  if (!session.authenticated) {
    return (
      <LoginScreen
        progress={desktopBridge !== undefined}
        onLogin={async (password) => setSession(await login(password))}
      />
    );
  }

  if (workEntry)
    return (
      <WorkTasksEntry
        initialTaskId={workEntry.taskId}
        key={`${session.owner.id}:${desktopConnection?.status === "configured" ? desktopConnection.serverUrl : "web"}`}
        onLogout={logoutWorkspace}
      />
    );

  if (nativeReady && !modelChecked) return <LaunchScreen status="正在读取模型设置" />;

  if (showModelSetup)
    return (
      <ModelSettingsScreen
        onboarding={!showSettings}
        progress={desktopBridge !== undefined && !showSettings}
        onDone={() => {
          setShowModelSetup(false);
          setModelChecked(true);
        }}
      />
    );

  const settingsPanel =
    showSettings && desktopSetupPlan?.status === "configured" ? (
      <DesktopSettingsScreen
        initialSection={settingsSection}
        counts={settingsCounts}
        ownerName={session.owner.name}
        onLogout={logoutWorkspace}
        plan={desktopSetupPlan.plan}
        material={material}
        connection={desktopConnection}
        localWorker={desktopLocalWorker}
        onConnection={() => setShowConnectionSetup(true)}
        onRole={() => setShowSetupPlan(true)}
        onBack={() => setShowSettings(false)}
      />
    ) : showSettings && !desktopBridge ? (
      <DesktopSettingsScreen
        initialSection={settingsSection}
        counts={settingsCounts}
        ownerName={session.owner.name}
        onLogout={logoutWorkspace}
        onBack={() => setShowSettings(false)}
      />
    ) : null;

  if (
    desktopBridge !== undefined &&
    desktopSetupPlan?.status === "configured" &&
    desktopSetupPlan.plan.localWorker &&
    !skipLocalWorkerSetup
  ) {
    if (desktopLocalWorker === undefined || desktopLocalWorker === null) {
      return <LaunchScreen status="正在检查这台电脑的工作状态" />;
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
      {/* Settings is a modal over the workspace (Settings artboard); the workspace stays visible. */}
      <div className="workspace-preserved" inert={showSettings}>
        <AuthenticatedWorkspace
          key={`${session.owner.id}:${desktopConnection?.status === "configured" ? desktopConnection.serverUrl : "web"}`}
          active={!showSettings}
          ownerName={session.owner.name}
          onSettings={(section = "general") => {
            setSettingsSection(section);
            setShowSettings(true);
          }}
          onLogout={logoutWorkspace}
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
  onSettings?: ((section?: DesktopSettingsSection) => void) | undefined;
  onLogout(): Promise<void>;
}) {
  const { values: preferences } = useWorkspacePreferences();
  const navigation = useWorkspaceNavigation();
  const location = navigation.location;
  // The New, EmptyWorkspace and WorkSupervision artboards have no right rail; elsewhere it
  // follows the Owner's preference. Home is only shown while the workspace has no conversation.
  const showDetails =
    preferences.rightPanelOpen &&
    location.kind !== "new" &&
    location.kind !== "home" &&
    location.kind !== "work";
  const destination = location.kind === "work" ? "work" : "chat";
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
  const [pluginsOpen, setPluginsOpen] = useState(false);
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
  const noticeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  const [unreadByChannel, setUnreadByChannel] = useState<Record<string, number>>({});
  // undefined until the first read, which is a baseline rather than "new messages".
  const previousUnread = useRef<Record<string, number>>(undefined);
  const [attention, setAttention] = useState(0);
  const notifications = useRef(new NotificationTracker());
  const notifyRef = useRef({ approvals: false, messages: false });
  notifyRef.current = {
    approvals: preferences.notifyApprovals,
    messages: preferences.notifyMessages,
  };
  // Returning to the window re-reads unread so the open channel is marked read on arrival.
  useEffect(() => {
    const attend = () => setAttention((value) => value + 1);
    window.addEventListener("focus", attend);
    document.addEventListener("visibilitychange", attend);
    return () => {
      window.removeEventListener("focus", attend);
      document.removeEventListener("visibilitychange", attend);
    };
  }, []);
  // Unread counts are Server facts (ADR-0047). Re-read them after workspace changes, debounced so
  // run progress bursts cost one request. The open channel is marked read only while the window
  // is attended; otherwise its new replies stay unread and may raise an opt-in notification.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attention only re-triggers the read.
  useEffect(() => {
    if (workspace === undefined) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const counts = await getUnreadCounts(controller.signal);
        const notices = notifications.current.messages(counts, workspace.bots, workspace.channels);
        if (selectedChannelId && counts[selectedChannelId] && windowIsAttended()) {
          delete counts[selectedChannelId];
          void markChannelRead(selectedChannelId).catch(() => undefined);
        }
        setUnreadByChannel(counts);
        // New messages elsewhere change the sidebar's previews and order (backlog C1); re-read
        // the workspace once. The next pass sees equal counts, so this cannot loop.
        const previous = previousUnread.current;
        const grew =
          previous !== undefined &&
          Object.entries(counts).some(([id, count]) => count > (previous[id] ?? 0));
        previousUnread.current = counts;
        if (grew) void refresh();
        if (notifyRef.current.messages && !windowIsAttended())
          for (const notice of notices) announce(notice);
      } catch {
        // Unread is advisory presentation; a failed read keeps the previous counts.
      }
    }, 600);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [workspace, selectedChannelId, attention]);
  // Desktop Dock badge (backlog C5): pending approvals plus unread; the main process applies the
  // Owner's 程序坞角标 preference and ignores this in the plain Web entry.
  const badgeCount =
    (workspace?.approvals.filter((approval) => approval.status === "pending").length ?? 0) +
    Object.values(unreadByChannel).reduce((total, count) => total + count, 0);
  useEffect(() => {
    void getOpenBotDesktopBridge()
      ?.setUnreadBadge?.(badgeCount)
      .catch(() => undefined);
  }, [badgeCount]);
  // New pending approvals are compared with the previous snapshot; the first one is a baseline.
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce reads only refs and navigation.
  useEffect(() => {
    if (workspace === undefined) return;
    const notices = notifications.current.approvals(
      workspace.approvals,
      workspace.bots,
      workspace.channels,
    );
    if (notifyRef.current.approvals && !windowIsAttended())
      for (const notice of notices) announce(notice);
  }, [workspace]);
  function announce(notice: SystemNotice) {
    // A conversation muted from its context menu raises no system notification on this device.
    const channel = workspace?.channels.find((item) => item.id === notice.channelId);
    const key = channel?.directBotId ? `bot:${channel.directBotId}` : `channel:${notice.channelId}`;
    if (sidebarOrganization.snapshot().muted.includes(key as `channel:${string}`)) return;
    void showSystemNotification(notice, () =>
      navigation.navigate({ kind: "channel", id: notice.channelId }),
    );
  }
  const [sharing, setSharing] = useState(false);
  const [sharedBotId, setSharedBotId] = useState<string>();
  // A 单聊's rail is the Bot 信息 rail, which reads the same profile as the Bot page.
  const railBotId =
    showDetails && destination === "chat"
      ? workspace?.channels.find((channel) => channel.id === selectedChannelId)?.directBotId
      : undefined;
  const directRequest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: leaving a view invalidates an in-flight direct-conversation open.
  useEffect(
    () => () => {
      directRequest.current += 1;
    },
    [location, active],
  );
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const {
    profile: employeeProfile,
    loading: employeeProfileLoading,
    error: employeeProfileError,
    refresh: refreshEmployeeProfile,
  } = useEmployeeProfile(selectedEmployeeId ?? railBotId);
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
    onNewConversation: () => navigation.navigate({ kind: "new" }),
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
        void refreshEmployeeProfile();
      },
      onEmployeeProfileChanged(botId, sections) {
        if (sections.includes("identity")) void refresh();
        void refreshEmployeeProfile(botId);
      },
      onNode: projectNode,
      onNodeRemoved: removeNode,
      onApproval: projectApproval,
      onRun: projectRun,
      onState: setWorkspaceRealtimeState,
    });
  }, [
    refreshEmployeeProfile,
    projectRun,
    projectNodes,
    projectNode,
    removeNode,
    projectApproval,
    refresh,
    workspaceReady,
  ]);

  /** 创建新 Bot: create immediately with a free name and fresh look, then open its 单聊. */
  async function handleQuickCreateBot() {
    if (!workspace) return;
    let model: ModelSelection | undefined;
    try {
      model = (await getOwnerPreferences()).defaultModel ?? undefined;
    } catch {
      // Without a readable default the 服务电脑 applies its own; creation does not depend on it.
    }
    let bot: Bot | undefined;
    for (let attempt = 0; !bot; attempt += 1) {
      try {
        bot = await createBot({
          name: nextBotName(workspace.bots, attempt),
          role: QUICK_BOT_ROLE,
          computerProfile: "model",
          appearance: freshAppearance(workspace.bots),
          ...(model ? { model } : {}),
        });
      } catch (cause) {
        // Another client may take the same default name first; try the next free one twice.
        if (attempt >= 2 || !(cause instanceof ApiError) || cause.status !== 409) throw cause;
      }
    }
    projectBot(bot);
    const channel = await openBotConversation(bot.id);
    projectChannel(channel);
    setMobilePanel(undefined);
    updatePreferences({ rightPanelOpen: true });
    selectChannel(channel.id);
    await refresh();
  }

  /** Entry points outside the New screen have no error line of their own; a notice reports it. */
  function quickCreateBot() {
    void handleQuickCreateBot().catch(() => showNotice("没能创建 Bot，请稍后重试。"));
  }

  function openNewChannel() {
    setMobilePanel(undefined);
    navigation.navigate({ kind: "new", channel: true });
  }

  async function handleJoinBot(botId: string) {
    if (selectedChannelId === undefined) return;
    await handleAddBotToChannel(selectedChannelId, botId);
  }

  /** New artboard: the first message opens a direct conversation or creates the channel. */
  async function handleStartChat({ botIds, asChannel, channelName, text }: NewChatStart) {
    let channel: Channel;
    if (botIds.length === 1 && !asChannel) {
      channel = await openBotConversation(botIds[0] ?? "");
    } else {
      const base = (
        channelName ??
        botIds.map((id) => workspace?.bots.find((bot) => bot.id === id)?.name ?? "Bot").join("、")
      ).slice(0, 76);
      let created: Channel | undefined;
      for (let attempt = 1; !created; attempt += 1) {
        try {
          created = await createChannel({
            name: attempt === 1 ? base : `${base} ${attempt}`,
            description: "",
            botIds,
          });
        } catch (cause) {
          // An auto-generated name may already exist; a chosen name is the Owner's to change.
          if (channelName || attempt >= 5 || !(cause instanceof ApiError) || cause.status !== 409)
            throw cause;
        }
      }
      channel = created;
    }
    projectChannel(channel);
    await createMessage(
      channel.id,
      botIds.length === 1 ? { content: text, botId: botIds[0] } : { content: text, botIds },
    );
    selectChannel(channel.id);
    await refresh();
  }

  async function handleAddBotToChannel(channelId: string, botId: string) {
    const channel = await joinBotToChannel(channelId, botId);
    projectChannel(channel);
    await refresh();
    showNotice("Bot 已加入频道。");
  }

  function markRead(channelId: string | undefined) {
    if (!channelId) return;
    setUnreadByChannel((current) => {
      if (!current[channelId]) return current;
      const { [channelId]: _read, ...rest } = current;
      return rest;
    });
    void markChannelRead(channelId).catch(() => undefined);
  }

  function channelForSidebarKey(key: string) {
    if (key.startsWith("channel:")) return key.slice(8);
    const botId = key.slice(4);
    return workspace?.channels.find((channel) => channel.directBotId === botId)?.id;
  }

  /** Appends plugin material to a channel draft addressed to one Bot, within the draft limit. */
  function insertPluginMaterial(channelId: string, botId: string, text: string) {
    const conversation = conversationSession.channel(channelId, botId);
    const draft = conversation.getSnapshot().draft;
    const next = [draft.text, text].filter(Boolean).join("\n\n");
    if (next.length > 8000) throw new Error("资料超过草稿剩余容量，请先缩短草稿或复制需要的片段。");
    conversation.edit({ text: next, targetBotId: botId, targetBotIds: [botId] });
    selectChannel(channelId);
  }

  async function renameEmployee(botId: string, name: string) {
    await renameBot(botId, name);
    await refresh();
  }

  async function handleRenameItem(key: string, name: string) {
    if (key.startsWith("bot:")) await renameBot(key.slice(4), name);
    else await renameChannel(key.slice(8), name);
    await refresh();
    showNotice("已重命名。");
  }

  async function handleDeleteItem(target: { kind: "channel" | "bot"; id: string }) {
    const directChannel =
      target.kind === "bot"
        ? workspace?.channels.find((channel) => channel.directBotId === target.id)?.id
        : undefined;
    let result: { pluginGrantsRemoved: boolean } | undefined;
    if (target.kind === "bot") result = await deleteBot(target.id);
    else await deleteChannel(target.id);
    const selectedDeleted =
      (target.kind === "channel" && selectedChannelId === target.id) ||
      (target.kind === "bot" &&
        (selectedEmployeeId === target.id || selectedChannelId === directChannel));
    sidebarOrganization.forget(`${target.kind}:${target.id}`);
    if (selectedDeleted) navigation.navigate({ kind: "home" });
    await refresh();
    showNotice(
      result && !result.pluginGrantsRemoved
        ? "Bot 已删除。插件授权未能自动移除，请在插件页检查。"
        : target.kind === "bot"
          ? "Bot 已删除，任务与审计记录已保留。"
          : "频道已删除，任务与审计记录已保留。",
    );
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

  // Notices artboard: a short confirmation disappears after 3 seconds. Each new one restarts the
  // timer, so an older timer never cuts a newer message short.
  function showNotice(message: string) {
    window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => setNotice(undefined), 3000);
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
      <LaunchScreen
        status="正在读取频道、Bot 和工作电脑"
        error={error}
        actions={
          <>
            {error ? (
              <button className="ob-setup-primary" type="button" onClick={() => refresh()}>
                重新连接
              </button>
            ) : null}
            <a className="ob-setup-link" href="#/tasks">
              打开任务监督
            </a>
          </>
        }
      />
    );
  }

  const selectedChannel = workspace.channels.find((channel) => channel.id === selectedChannelId);
  const selectedRun = workspace.runs.find((run) => run.id === selectedRunId);
  const browserBot = browserBotId
    ? workspace.bots.find((bot) => bot.id === browserBotId)
    : undefined;
  const sharedBot = sharedBotId ? workspace.bots.find((bot) => bot.id === sharedBotId) : undefined;
  // Plugin material goes to the open channel's first Bot, as the former library screen did.
  const pluginBotId = selectedChannel?.botIds[0];
  const pluginScope =
    selectedChannel && pluginBotId
      ? { channelId: selectedChannel.id, botId: pluginBotId }
      : undefined;
  const railBotKey = selectedEmployeeId ?? railBotId;
  const railBot = railBotKey ? workspace.bots.find((bot) => bot.id === railBotKey) : undefined;
  const profileTitle =
    destination === "chat" && selectedEmployeeId ? employeeProfile?.employee : undefined;
  const headerAvatars = profileTitle
    ? [profileTitle]
    : (selectedChannel?.botIds.flatMap((id) => {
        const bot = workspace.bots.find((item) => item.id === id);
        return bot ? [bot] : [];
      }) ?? []);
  const headerTitle =
    destination === "work"
      ? "任务监督"
      : selectedEmployeeId
        ? (employeeProfile?.employee.name ?? "Bot 档案")
        : location.kind === "new"
          ? "新建聊天"
          : (selectedChannel?.name ?? "");
  // The title pill opens the rail for a conversation or a Bot profile (Main/Profile artboards).
  const railAvailable = destination === "chat" && Boolean(selectedChannel || selectedEmployeeId);

  return (
    <div
      className={`app-shell desktop-workspace ${error ? "workspace-refresh-failed" : ""} ${destination === "chat" && selectedChannel ? "channel-view" : ""} ${showDetails ? "" : "without-context"} ${preferences.leftPanelOpen ? "" : "without-sidebar"}`}
    >
      <LaunchExit />
      <WorkspaceHeader
        title={headerTitle}
        avatars={headerAvatars}
        group={!profileTitle && Boolean(selectedChannel) && !selectedChannel?.directBotId}
        railOpen={showDetails}
        onToggleRail={
          railAvailable
            ? () => updatePreferences({ rightPanelOpen: !preferences.rightPanelOpen })
            : undefined
        }
        realtimeState={workspaceRealtimeState}
        sidebarOpen={preferences.leftPanelOpen}
        onOpenSidebar={() => updatePreferences({ leftPanelOpen: true })}
        onShare={selectedChannel ? () => setSharing(true) : undefined}
      />
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
          activity={sidebarActivity(workspace.channels)}
          runs={workspace.runs}
          ownerName={ownerName}
          destination={destination}
          onAutomations={() => onSettings?.("routines")}
          onWork={() => navigation.navigate({ kind: "work" })}
          onSkills={() => setPluginsOpen(true)}
          selectedChannelId={destination === "chat" ? selectedChannel?.id : undefined}
          selectedBotId={
            destination === "chat"
              ? (selectedEmployeeId ?? selectedChannel?.directBotId)
              : undefined
          }
          onSelectChannel={selectChannel}
          onSelectBot={(botId) => void openDirectConversation(botId)}
          onOpenBotProfile={openEmployee}
          unreadCounts={sidebarUnread(workspace.channels, unreadByChannel)}
          onMarkRead={(key) => markRead(channelForSidebarKey(key))}
          onRenameItem={handleRenameItem}
          onDeleteItem={handleDeleteItem}
          onAddBotToChannel={handleAddBotToChannel}
          onNewChat={() => navigation.navigate({ kind: "new" })}
          newChatActive={location.kind === "new"}
          onCreateBot={quickCreateBot}
          onCreateChannel={openNewChannel}
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
      {destination === "work" ? null : selectedEmployeeId ? (
        <EmployeeProfileView
          key={`${selectedEmployeeId}:${employeeInitialTab}`}
          initialTab={employeeInitialTab}
          profile={employeeProfile}
          loading={employeeProfileLoading}
          error={employeeProfileError}
          onRetry={() => void refreshEmployeeProfile(selectedEmployeeId)}
          onAssign={() => assignEmployee(selectedEmployeeId)}
          onExport={() => setEmployeeExportOpen(true)}
          onProfileChanged={() => refreshEmployeeProfile(selectedEmployeeId)}
          onManageModels={() => setModelServicesOpen(true)}
          modelServicesVersion={modelServicesVersion}
          onOpenBrowser={() => setBrowserBotId(selectedEmployeeId)}
          channels={workspace.channels}
          onOpenRun={(runId) => {
            // The sheet reads the workspace projection; an older run may not be loaded there.
            if (workspace.runs.some((run) => run.id === runId)) setSelectedRunId(runId);
            else showNotice("这项任务较早，暂时无法在这里打开详情。");
          }}
        />
      ) : selectedChannel ? (
        <ChannelWorkspace
          key={selectedChannel.id}
          session={conversationSession}
          globalHeader
          onBotChanged={refresh}
          approvals={workspace.approvals}
          nodes={workspace.nodes}
          frames={framesByRun}
          onDecideApproval={handleDecideApproval}
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
          onOpenMembers={() => updatePreferences({ rightPanelOpen: true })}
          onNewRoutine={() => onSettings?.("routines")}
          onOpenSettings={onSettings ? (section) => onSettings(section) : undefined}
          onOpenHosts={() => setDialog("node")}
        />
      ) : location.kind === "new" ? (
        <NewChatScreen
          key={location.channel ? "new-channel" : "new-chat"}
          bots={workspace.bots}
          initialChannelMode={location.channel === true}
          onCreateBot={handleQuickCreateBot}
          onStart={handleStartChat}
          onClose={
            navigation.canGoBack ? navigation.back : () => navigation.navigate({ kind: "home" })
          }
        />
      ) : (
        <EmptyWorkspace
          computers={workspace.nodes.length}
          onCreateBot={quickCreateBot}
          onCreateChannel={openNewChannel}
          onImportBot={() => setEmployeeImportOpen(true)}
          onManageModels={() => setModelServicesOpen(true)}
          onManageComputers={() => setDialog("node")}
        />
      )}

      <div id="workspace-details" className="workspace-details" hidden={!showDetails}>
        {showDetails &&
          (destination === "chat" && railBot ? (
            <BotInfoRail
              key={railBot.id}
              bot={railBot}
              profile={employeeProfile?.employee.id === railBot.id ? employeeProfile : undefined}
              workspace={workspace}
              onCollapse={() => updatePreferences({ rightPanelOpen: false })}
              onShare={() => setSharedBotId(railBot.id)}
              onRename={(name) => renameEmployee(railBot.id, name)}
              onProfileChanged={async () => {
                await refreshEmployeeProfile(railBot.id);
                await refresh();
              }}
              onDelete={() => handleDeleteItem({ kind: "bot", id: railBot.id })}
              onDecideApproval={handleDecideApproval}
              onManageModels={() => setModelServicesOpen(true)}
              onOpenSettings={onSettings}
              modelServicesVersion={modelServicesVersion}
            />
          ) : (
            <ContextRail
              selectedChannelId={destination === "chat" ? selectedChannel?.id : undefined}
              workspace={workspace}
              onDecideApproval={handleDecideApproval}
              onInspectRun={setSelectedRunId}
              onOpenBot={openEmployee}
              onJoin={handleJoinBot}
              onRemove={handleRemoveBot}
              onCollapse={() => updatePreferences({ rightPanelOpen: false })}
              onOpenSettings={onSettings}
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
        onCreateBot={quickCreateBot}
        onCreateChannel={openNewChannel}
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
        <TaskSheet
          key={selectedRun.id}
          channelName={
            workspace.channels.find((channel) => channel.id === selectedRun.channelId)?.name
          }
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

      {dialog === "node" ? (
        <NodeManagerDialog onlineNodes={workspace.nodes} onClose={() => setDialog(undefined)} />
      ) : null}
      {browserBot ? (
        <EmployeeBrowser bot={browserBot} onClose={() => setBrowserBotId(undefined)} />
      ) : null}
      {pluginsOpen ? (
        <PluginsDialog
          bots={workspace.bots}
          scope={pluginScope}
          onInsertMaterial={
            pluginScope
              ? (text) => {
                  insertPluginMaterial(pluginScope.channelId, pluginScope.botId, text);
                  setPluginsOpen(false);
                }
              : undefined
          }
          onManage={onSettings ? () => onSettings("plugins") : undefined}
          onClose={() => setPluginsOpen(false)}
        />
      ) : null}
      {modelServicesOpen ? (
        <ModelConnectionsDialog
          onClose={() => setModelServicesOpen(false)}
          onChanged={() => setModelServicesVersion((version) => version + 1)}
        />
      ) : null}
      {sharedBot ? (
        <ExportEmployeeDialog
          employee={sharedBot}
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
        <div className="ob-toast" role="status">
          <span>{notice}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => {
              window.clearTimeout(noticeTimer.current);
              setNotice(undefined);
            }}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Row activity for the sidebar: a direct conversation's activity belongs to its Bot. */
function sidebarActivity(channels: Channel[]): Record<SidebarItemKey, SidebarActivity> {
  const result: Record<SidebarItemKey, SidebarActivity> = {};
  for (const channel of channels) {
    if (!channel.lastActivityAt && !channel.latestMessage) continue;
    const value = { lastActivityAt: channel.lastActivityAt, latestMessage: channel.latestMessage };
    const key: SidebarItemKey = channel.directBotId
      ? `bot:${channel.directBotId}`
      : `channel:${channel.id}`;
    result[key] = value;
  }
  return result;
}

function sidebarUnread(channels: Channel[], counts: Record<string, number>) {
  const result: Partial<Record<`channel:${string}` | `bot:${string}`, number>> = {};
  for (const channel of channels) {
    const count = counts[channel.id];
    if (!count) continue;
    if (channel.directBotId) result[`bot:${channel.directBotId}`] = count;
    else result[`channel:${channel.id}`] = count;
  }
  return result;
}
