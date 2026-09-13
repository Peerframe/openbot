import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  type Session,
  safeStorage,
  session,
  shell,
  systemPreferences,
  utilityProcess,
  type WebContents,
} from "electron";
import { originalAttachmentSaveDialog } from "./attachment-save-dialog.js";
import { FileDesktopConnectionStore } from "./connection-config.js";
import { DesktopConnectionController } from "./connection-controller.js";
import { desktopWindowIconPath } from "./desktop-icon.js";
import {
  isDesktopSessionAuthenticated,
  issueDesktopNodeEnrollmentToken,
} from "./desktop-server-actions.js";
import { openDesktopSupportLink } from "./desktop-support-links.js";
import { isTrustedDesktopIpcSender } from "./ipc-security.js";
import {
  DESKTOP_ENTRY_URL,
  DESKTOP_SCHEME,
  isDesktopAssetRequestMethod,
  resolveDesktopAssetPath,
} from "./local-content.js";
import { DesktopLocalWorkerController } from "./local-worker-controller.js";
import { MacOSWorkerCompanion } from "./macos-worker-companion.js";
import { DesktopMicrophonePolicy } from "./microphone-policy.js";
import { NativeServerController } from "./native-server.js";
import { DesktopNavigationMenuController } from "./navigation-menu.js";
import { desktopProfileCompatibility } from "./profile-compatibility.js";
import { DesktopReportSaver } from "./report-save.js";
import {
  DESKTOP_CONFIGURE_SERVER_CHANNEL,
  DESKTOP_CONNECTION_STATE_CHANNEL,
  DESKTOP_ENABLE_LOCAL_WORKER_CHANNEL,
  DESKTOP_LOCAL_WORKER_STATE_CHANNEL,
  DESKTOP_NAVIGATION_MENU_STATE_CHANNEL,
  DESKTOP_OPEN_LOCAL_WORKER_SETTINGS_CHANNEL,
  DESKTOP_SAVE_SETUP_PLAN_CHANNEL,
  DESKTOP_SET_SIDEBAR_TRANSLUCENCY_CHANNEL,
  DESKTOP_SETUP_LOCAL_WORKER_CHANNEL,
  DESKTOP_SETUP_PLAN_STATE_CHANNEL,
  DESKTOP_SIDEBAR_MATERIAL_CHANGED_CHANNEL,
  DESKTOP_SIDEBAR_MATERIAL_STATE_CHANNEL,
} from "./runtime-contract.js";
import { createDesktopWebPreferences, DESKTOP_WINDOW_OPEN_DECISION } from "./security-policy.js";
import { DesktopEventStreamLifecycle } from "./server-proxy.js";
import { FileDesktopSetupPlanStore } from "./setup-plan.js";
import { DesktopSetupPlanController } from "./setup-plan-controller.js";
import { SidebarMaterialController } from "./sidebar-material.js";

let nativeServer: NativeServerController | undefined;
let quitting = false;
let mainWindow: BrowserWindow | undefined;
let desktopSession: Session | undefined;
let sidebarMaterial: SidebarMaterialController | undefined;
let navigationMenu: DesktopNavigationMenuController | undefined;

const compatibleProfile = desktopProfileCompatibility(
  app.getPath("appData"),
  process.platform,
  app.name,
);
if (compatibleProfile) {
  // Electron chooses its Keychain service before ready; the visible name is restored afterward.
  app.setName(compatibleProfile.encryptionName);
  app.setPath("userData", compatibleProfile.userData);
}

// Every renderer is sandboxed globally before Electron creates a process.
app.enableSandbox();
// A profile owns one bootstrap transaction and one local database supervisor.
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on("second-instance", () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
});
protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      codeCache: true,
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
]);

const eventStreams = new DesktopEventStreamLifecycle();
const microphonePolicy = new DesktopMicrophonePolicy();

function lockDownSession(desktopSession: Session): void {
  desktopSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    microphonePolicy.allows({
      contentsId: contents?.id,
      permission,
      ...details,
      mediaTypes: details.mediaType ? [details.mediaType] : undefined,
    }),
  );
  desktopSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      microphonePolicy.allows({
        contentsId: contents.id,
        permission,
        ...details,
        mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
      }),
    );
  });
  desktopSession.on("will-download", (event) => event.preventDefault());
}

function lockDownWebContents(contents: WebContents): void {
  const openSupportLink = (url: string) => {
    const expected = mainWindow?.isDestroyed() === false ? mainWindow.webContents : undefined;
    void openDesktopSupportLink(url, contents, expected, (destination) =>
      shell.openExternal(destination),
    ).catch(() => {
      if (!quitting && mainWindow?.isDestroyed() === false) {
        dialog.showErrorBox("无法打开支持页面", "系统浏览器未能打开页面，请稍后重试。");
      }
    });
  };
  contents.setWindowOpenHandler(({ url }) => {
    openSupportLink(url);
    return DESKTOP_WINDOW_OPEN_DECISION;
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-navigate", (event) => {
    event.preventDefault();
    openSupportLink(event.url);
  });
  contents.on("will-redirect", (event) => event.preventDefault());
}

function registerDesktopIpc(
  connectionController: DesktopConnectionController,
  setupPlanController: DesktopSetupPlanController,
  localWorkerController: DesktopLocalWorkerController,
): void {
  ipcMain.handle("openbot:begin-voice-capture", async (event) => {
    const window = mainWindow;
    if (
      !window ||
      window.isDestroyed() ||
      !window.isFocused() ||
      !isTrustedDesktopIpcSender(event, window.webContents)
    )
      return false;
    const generation = microphonePolicy.beginAttempt();
    if (
      process.platform === "darwin" &&
      !(await systemPreferences.askForMediaAccess("microphone").catch(() => false))
    )
      return false;
    if (
      quitting ||
      window !== mainWindow ||
      window.isDestroyed() ||
      !isTrustedDesktopIpcSender(event, window.webContents)
    )
      return false;
    return microphonePolicy.arm(window.webContents.id, generation);
  });
  ipcMain.handle("openbot:end-voice-capture", (event) => {
    if (isTrustedDesktopIpcSender(event, mainWindow?.webContents)) microphonePolicy.revoke();
  });
  const reportSaver = new DesktopReportSaver({
    connection: () => connectionController.getState(),
    fetch: (input, init) => {
      if (!desktopSession) throw new Error("Desktop session is unavailable.");
      return desktopSession.fetch(input, init);
    },
    active: () => !quitting && mainWindow !== undefined && !mainWindow.isDestroyed(),
    chooseAttachmentPath: async (name) => {
      const window = mainWindow;
      if (!window || window.isDestroyed()) return undefined;
      const result = await dialog.showSaveDialog(window, originalAttachmentSaveDialog(name));
      return result.canceled ? undefined : result.filePath;
    },
    choosePath: async (name) => {
      const window = mainWindow;
      if (!window || window.isDestroyed()) return undefined;
      const image = name.endsWith(".png");
      const employee = name.endsWith(".json");
      const result = await dialog.showSaveDialog(window, {
        title: employee ? "保存员工模板" : image ? "保存图片" : "保存报告",
        buttonLabel: "保存",
        defaultPath: name,
        filters: [
          employee
            ? { name: "OpenBot 员工模板", extensions: ["json"] }
            : image
              ? { name: "PNG 图片", extensions: ["png"] }
              : { name: "Markdown 报告", extensions: ["md"] },
        ],
        message: "选择新文件名保存；已有文件不会被覆盖。",
        showsTagField: false,
      });
      return result.canceled ? undefined : result.filePath;
    },
  });
  ipcMain.removeHandler("openbot:save-attachment");
  ipcMain.handle("openbot:save-attachment", (event, input: unknown) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents))
      throw new Error("Desktop IPC sender is not allowed.");
    return reportSaver.saveAttachment(input);
  });
  ipcMain.removeHandler("openbot:save-report");
  ipcMain.handle("openbot:save-report", (event, artifactId: unknown) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents))
      throw new Error("Desktop IPC sender is not allowed.");
    return reportSaver.save(artifactId);
  });
  ipcMain.removeHandler("openbot:save-employee-template");
  ipcMain.handle("openbot:save-employee-template", (event, input: unknown) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents))
      throw new Error("Desktop IPC sender is not allowed.");
    return reportSaver.saveEmployeeTemplate(input);
  });
  ipcMain.removeHandler(DESKTOP_NAVIGATION_MENU_STATE_CHANNEL);
  ipcMain.handle(DESKTOP_NAVIGATION_MENU_STATE_CHANNEL, (event, value: unknown) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents)) {
      throw new Error("Desktop IPC sender is not allowed.");
    }
    if (!navigationMenu) throw new Error("Desktop navigation menu is unavailable.");
    navigationMenu.update(value);
  });
  ipcMain.removeHandler(DESKTOP_SET_SIDEBAR_TRANSLUCENCY_CHANNEL);
  ipcMain.removeHandler(DESKTOP_SIDEBAR_MATERIAL_STATE_CHANNEL);
  ipcMain.handle(DESKTOP_SET_SIDEBAR_TRANSLUCENCY_CHANNEL, (event, enabled: unknown) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents)) {
      throw new Error("Desktop IPC sender is not allowed.");
    }
    return sidebarMaterial?.setEnabled(enabled) ?? { status: "unavailable" };
  });
  ipcMain.handle(DESKTOP_SIDEBAR_MATERIAL_STATE_CHANNEL, (event) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents)) {
      throw new Error("Desktop IPC sender is not allowed.");
    }
    return sidebarMaterial?.refresh() ?? { status: "unavailable" };
  });
  ipcMain.removeHandler(DESKTOP_CONNECTION_STATE_CHANNEL);
  ipcMain.removeHandler(DESKTOP_CONFIGURE_SERVER_CHANNEL);
  ipcMain.removeHandler(DESKTOP_SETUP_PLAN_STATE_CHANNEL);
  ipcMain.removeHandler(DESKTOP_SAVE_SETUP_PLAN_CHANNEL);
  ipcMain.removeHandler(DESKTOP_LOCAL_WORKER_STATE_CHANNEL);
  ipcMain.removeHandler(DESKTOP_SETUP_LOCAL_WORKER_CHANNEL);
  ipcMain.removeHandler(DESKTOP_ENABLE_LOCAL_WORKER_CHANNEL);
  ipcMain.removeHandler(DESKTOP_OPEN_LOCAL_WORKER_SETTINGS_CHANNEL);
  ipcMain.handle(DESKTOP_CONNECTION_STATE_CHANNEL, (event) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents)) {
      throw new Error("Desktop IPC sender is not allowed.");
    }
    return connectionController.getState();
  });
  ipcMain.handle(DESKTOP_CONFIGURE_SERVER_CHANNEL, (event, serverUrl: unknown) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents)) {
      throw new Error("Desktop IPC sender is not allowed.");
    }
    return connectionController.configure(serverUrl);
  });
  ipcMain.handle(DESKTOP_SETUP_PLAN_STATE_CHANNEL, (event) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents)) {
      throw new Error("Desktop IPC sender is not allowed.");
    }
    return setupPlanController.getState();
  });
  ipcMain.handle(DESKTOP_SAVE_SETUP_PLAN_CHANNEL, async (event, plan: unknown) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents)) {
      throw new Error("Desktop IPC sender is not allowed.");
    }
    const result = await setupPlanController.save(plan);
    if (result.status === "configured" && result.plan.mode !== "host") await nativeServer?.stop();
    return result;
  });
  ipcMain.handle(DESKTOP_LOCAL_WORKER_STATE_CHANNEL, (event) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents)) {
      throw new Error("Desktop IPC sender is not allowed.");
    }
    return localWorkerController.getState();
  });
  ipcMain.handle(DESKTOP_SETUP_LOCAL_WORKER_CHANNEL, (event, nodeId: unknown) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents)) {
      throw new Error("Desktop IPC sender is not allowed.");
    }
    return localWorkerController.setup(nodeId);
  });
  ipcMain.handle(DESKTOP_ENABLE_LOCAL_WORKER_CHANNEL, (event) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents)) {
      throw new Error("Desktop IPC sender is not allowed.");
    }
    return localWorkerController.enable();
  });
  ipcMain.handle(DESKTOP_OPEN_LOCAL_WORKER_SETTINGS_CHANNEL, (event) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents)) {
      throw new Error("Desktop IPC sender is not allowed.");
    }
    return localWorkerController.openSettings();
  });
}

async function createMainWindow(activeSession: Session): Promise<void> {
  // Match the renderer's light palette; this is app-local and leaves macOS settings intact.
  nativeTheme.themeSource = "light";
  const preloadPath = join(app.getAppPath(), "dist", "preload.cjs");
  const window = new BrowserWindow({
    // Preserve native macOS controls while letting the sidebar extend into window chrome.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 20, y: 20 } }
      : {}),
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    height: 840,
    icon: desktopWindowIconPath({
      appPath: app.getAppPath(),
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    minHeight: 640,
    minWidth: 960,
    show: false,
    title: "OpenBot",
    webPreferences: {
      ...createDesktopWebPreferences(preloadPath, !app.isPackaged),
      session: activeSession,
    },
    width: 1280,
  });

  mainWindow = window;
  navigationMenu?.reset();
  window.on("focus", () => navigationMenu?.refresh());
  window.on("blur", () => navigationMenu?.refresh());
  window.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame) {
      microphonePolicy.revoke();
      eventStreams.clear();
      navigationMenu?.reset();
    }
  });
  window.webContents.on("did-finish-load", () => navigationMenu?.refresh());
  window.webContents.on("render-process-gone", () => {
    microphonePolicy.revoke();
    eventStreams.clear();
    navigationMenu?.reset();
  });
  const material = new SidebarMaterialController({
    platform: process.platform,
    window,
    accessibility: () => ({
      reducedTransparency: nativeTheme.prefersReducedTransparency,
      highContrast: nativeTheme.shouldUseHighContrastColors,
    }),
    changed: (state) => {
      if (!window.isDestroyed()) {
        window.webContents.send(DESKTOP_SIDEBAR_MATERIAL_CHANGED_CHANNEL, state);
      }
    },
  });
  sidebarMaterial = material;
  const refreshMaterial = () => material.refresh();
  nativeTheme.on("updated", refreshMaterial);
  window.on("focus", refreshMaterial);
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    microphonePolicy.revoke();
    eventStreams.clear();
    nativeTheme.removeListener("updated", refreshMaterial);
    if (sidebarMaterial === material) sidebarMaterial = undefined;
    if (mainWindow === window) mainWindow = undefined;
    navigationMenu?.reset();
  });
  await window.loadURL(DESKTOP_ENTRY_URL);
}

async function startDesktop(): Promise<void> {
  if (compatibleProfile) app.setName("OpenBot");
  const activeSession = session.fromPartition("persist:openbot-desktop", { cache: true });
  const rendererRoot = join(app.getAppPath(), "dist", "renderer");
  const connectionController = new DesktopConnectionController({
    clearSessionData: () => {
      eventStreams.clear();
      return activeSession.clearData({
        dataTypes: [
          "cache",
          "cookies",
          "fileSystems",
          "indexedDB",
          "localStorage",
          "serviceWorkers",
        ],
      });
    },
    confirmServer: async (serverUrl) => {
      if (nativeServer?.owns(serverUrl)) return true;
      const window = mainWindow;
      if (window === undefined || window.isDestroyed()) {
        throw new Error("Desktop confirmation window is unavailable.");
      }
      const result = await dialog.showMessageBox(window, {
        buttons: ["连接", "取消"],
        cancelId: 1,
        defaultId: 1,
        detail: `OpenBot Desktop 将只连接这个 Server：\n${serverUrl}\n\n切换 Server 会清除当前 Desktop 会话。`,
        message: "确认 OpenBot Server",
        noLink: true,
        title: "OpenBot",
        type: "question",
      });
      return result.response === 0;
    },
    fetch: (input, init) => activeSession.fetch(input, init),
    store: new FileDesktopConnectionStore(join(app.getPath("userData"), "openbot", "server.json")),
  });
  const nativeRuntimeRoot = app.isPackaged
    ? join(process.resourcesPath, "native-runtime")
    : join(app.getAppPath(), "native-runtime");
  nativeServer = new NativeServerController({
    runtimeRoot: nativeRuntimeRoot,
    dataRoot: join(app.getPath("userData"), "openbot", "local-server"),
    platform: process.platform,
    encrypt: async (value) => {
      if (!(await safeStorage.isAsyncEncryptionAvailable()))
        throw new Error("Operating-system secret storage is unavailable.");
      return (await safeStorage.encryptStringAsync(value)).toString("base64");
    },
    decrypt: async (value) => {
      if (!(await safeStorage.isAsyncEncryptionAvailable()))
        throw new Error("Operating-system secret storage is unavailable.");
      return (await safeStorage.decryptStringAsync(Buffer.from(value, "base64"))).result;
    },
    launchServer: async (env) => {
      const child = utilityProcess.fork(join(nativeRuntimeRoot, "apps/server/dist/index.js"), [], {
        env,
        cwd: nativeRuntimeRoot,
        stdio: "ignore",
        serviceName: "OpenBot Server",
      });
      let alive = true;
      child.once("exit", () => {
        alive = false;
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Server startup timed out."));
        }, 30_000);
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Server exited before readiness."));
        });
        child.on("message", (message: unknown) => {
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            "port" in message &&
            message.type === "openbot-server-ready" &&
            message.port === Number(env.OPENBOT_PORT)
          ) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      return {
        isAlive: () => alive,
        stop: async () => {
          if (!alive) return;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              if (alive && child.pid !== undefined) {
                try {
                  process.kill(child.pid, "SIGKILL");
                } catch {
                  /* Child already exited. */
                }
              }
              resolve();
            }, 12_000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            if (process.platform === "win32")
              child.postMessage({ type: "openbot-server-shutdown" });
            else child.kill();
          });
        },
      };
    },
    authenticate: authenticateLocalServer,
    connect: async (serverUrl, ownerPassword) => {
      const connected = await connectionController.configure(serverUrl);
      if (connected.status !== "configured") throw new Error("Local Server not ready.");
      await authenticateLocalServer(serverUrl, ownerPassword);
    },
  });
  async function authenticateLocalServer(serverUrl: string, ownerPassword: string): Promise<void> {
    const current = connectionController.getState();
    if (
      !nativeServer?.owns(serverUrl) ||
      current.status !== "configured" ||
      current.serverUrl !== serverUrl
    )
      throw new Error("Local Server connection changed.");
    const response = await activeSession.fetch(`${serverUrl}/api/v1/auth/login`, {
      method: "POST",
      credentials: "include",
      redirect: "error",
      headers: { "Content-Type": "application/json", Origin: serverUrl },
      body: JSON.stringify({ password: ownerPassword }),
      signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Local session could not be created.");
    if (
      !(await isDesktopSessionAuthenticated({ status: "configured", serverUrl }, (input, init) =>
        activeSession.fetch(input, init),
      ))
    )
      throw new Error("Local session could not be verified.");
  }
  const setupPlanController = new DesktopSetupPlanController(
    new FileDesktopSetupPlanStore(join(app.getPath("userData"), "openbot", "setup-plan.json")),
  );
  const localWorkerController = new DesktopLocalWorkerController({
    companion: new MacOSWorkerCompanion(process.resourcesPath),
    getConnectionState: () => connectionController.getState(),
    getSetupPlanState: () => setupPlanController.getState(),
    isAuthenticated: () =>
      isDesktopSessionAuthenticated(connectionController.getState(), (input, init) =>
        activeSession.fetch(input, init),
      ),
    issueEnrollmentToken: (nodeId, connection) =>
      issueDesktopNodeEnrollmentToken(nodeId, connection, (input, init) =>
        activeSession.fetch(input, init),
      ),
    platform: process.platform,
  });
  await Promise.all([connectionController.initialize(), setupPlanController.initialize()]);
  lockDownSession(activeSession);
  await activeSession.protocol.handle(DESKTOP_SCHEME, async (request) => {
    const serverResponse = await eventStreams.forward(
      request,
      connectionController.getState(),
      (input, init) => activeSession.fetch(input, init),
    );
    if (serverResponse !== undefined) return serverResponse;

    if (!isDesktopAssetRequestMethod(request.method)) {
      return new Response("Method not allowed", { status: 405 });
    }

    const assetPath = resolveDesktopAssetPath(rendererRoot, request.url);
    if (!assetPath) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(assetPath).toString());
  });
  ipcMain.handle("openbot:native-server-state", (event) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents))
      throw new Error("Untrusted sender.");
    return nativeServer?.getState();
  });
  ipcMain.handle("openbot:install-native-server", (event) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents))
      throw new Error("Untrusted sender.");
    const plan = setupPlanController.getState();
    if (plan.status !== "configured" || plan.plan.mode !== "host")
      throw new Error("Service role required.");
    return nativeServer?.start();
  });
  ipcMain.handle("openbot:restore-local-session", async (event) => {
    if (!isTrustedDesktopIpcSender(event, mainWindow?.webContents))
      throw new Error("Untrusted sender.");
    const plan = setupPlanController.getState();
    const connection = connectionController.getState();
    if (
      plan.status !== "configured" ||
      plan.plan.mode !== "host" ||
      connection.status !== "configured" ||
      !nativeServer?.owns(connection.serverUrl)
    )
      return { status: "unavailable" };
    const result = await nativeServer.restoreSession(connection.serverUrl);
    const current = connectionController.getState();
    const currentPlan = setupPlanController.getState();
    return current.status === "configured" &&
      current.serverUrl === connection.serverUrl &&
      currentPlan.status === "configured" &&
      currentPlan.plan.mode === "host"
      ? result
      : { status: "unavailable" };
  });
  desktopSession = activeSession;
  registerDesktopIpc(connectionController, setupPlanController, localWorkerController);
  navigationMenu = new DesktopNavigationMenuController({
    appName: app.name,
    platform: process.platform,
    getWindow: () => mainWindow,
    install: (template) => {
      const menu = Menu.buildFromTemplate(template);
      Menu.setApplicationMenu(menu);
      return menu;
    },
  });
  await createMainWindow(activeSession);
}

app.on("web-contents-created", (_event, contents) => lockDownWebContents(contents));

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (!desktopSession) {
      console.error("OpenBot Desktop session is unavailable during activation.");
      app.exit(1);
      return;
    }
    void createMainWindow(desktopSession).catch((cause: unknown) => {
      console.error("OpenBot Desktop could not create its local window.", cause);
      app.exit(1);
    });
  }
});

app.on("before-quit", (event) => {
  eventStreams.clear();
  if (quitting || nativeServer === undefined) return;
  event.preventDefault();
  quitting = true;
  void nativeServer.stop().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void app
  .whenReady()
  .then(() => (ownsInstance ? startDesktop() : undefined))
  .catch((cause: unknown) => {
    console.error("OpenBot Desktop failed closed during startup.", cause);
    app.exit(1);
  });
