// Entry point of the design preview (preview.html, dev only): the scene table and the page that
// renders one scene on synthetic data for comparison with its artboard.
import { installPreviewTransport } from "./transport";
import { createWorld } from "./world";
import "../global-styles";
import "./preview.css";
import { installAppFavicon } from "../app-favicon";
import { installOverlayScrollbars } from "../overlay-scrollbars";

installAppFavicon();
installOverlayScrollbars();

/*
 * Design preview entry (dev only): `npm run design:preview -w @openbot/web`, then open
 * http://127.0.0.1:5179/preview.html?scene=<name>. Each scene renders the real product UI on the
 * synthetic world so it can be screenshotted next to its artboard at 1440×900.
 */

type AppScene = {
  kind: "app";
  title: string;
  artboard: string;
  world?: "full" | "empty" | "new-bot" | "long";
  start?:
    | { kind: "home" }
    | { kind: "new"; channel?: true }
    | { kind: "work" }
    | { kind: "channel"; id: string };
  rail?: boolean;
};
type ComponentScene = { kind: "component"; title: string; artboard: string };

export const scenes: Record<string, AppScene | ComponentScene> = {
  channel: {
    kind: "app",
    title: "频道对话（右栏打开）",
    artboard: "Main",
    start: { kind: "channel", id: "c-market" },
    rail: true,
  },
  "channel-long": {
    kind: "app",
    title: "长对话（分页加载、日期浮标）",
    artboard: "LongLists",
    world: "long",
    start: { kind: "channel", id: "c-market" },
    rail: false,
  },
  "channel-closed": {
    kind: "app",
    title: "频道对话（右栏收起）",
    artboard: "Main",
    start: { kind: "channel", id: "c-market" },
    rail: false,
  },
  direct: {
    kind: "app",
    title: "单聊（Bot 信息右栏）",
    artboard: "BotInfo",
    start: { kind: "channel", id: "direct-b-research" },
    rail: true,
  },
  new: { kind: "app", title: "新建聊天", artboard: "New", start: { kind: "new" } },
  "new-channel": {
    kind: "app",
    title: "创建频道",
    artboard: "NewGroup",
    start: { kind: "new", channel: true },
  },
  "new-bot": {
    kind: "app",
    title: "新 Bot 的单聊（定分工）",
    artboard: "NewBotChat",
    world: "new-bot",
    start: { kind: "channel", id: "direct-b-new" },
    rail: true,
  },
  work: { kind: "app", title: "任务监督", artboard: "WorkSupervision", start: { kind: "work" } },
  empty: {
    kind: "app",
    title: "空工作区",
    artboard: "EmptyWorkspace",
    world: "empty",
    start: { kind: "home" },
  },
  avatars: { kind: "component", title: "头像系统 v3", artboard: "Avatars" },
  banner: { kind: "component", title: "README 横幅（2172×724）", artboard: "AppIcon" },
  groups: { kind: "component", title: "群组头像", artboard: "GroupAvatars" },
  "dialog-share": { kind: "component", title: "分享", artboard: "DialogShare" },
  "dialog-export": { kind: "component", title: "分享 Bot 模板", artboard: "DialogExport" },
  "dialog-import": { kind: "component", title: "导入 Bot 模板", artboard: "DialogImport" },
  "dialog-delete": { kind: "component", title: "永久删除", artboard: "DialogDelete" },
  "dialog-pair": { kind: "component", title: "配对工作电脑", artboard: "DialogPairHost" },
  "dialog-model": { kind: "component", title: "连接模型服务", artboard: "DialogModel" },
  "dialog-trash": { kind: "component", title: "回收站与永久删除", artboard: "ChannelFilesTrash" },
  browser: { kind: "component", title: "Bot 的浏览器", artboard: "EmployeeBrowser" },
  settings: { kind: "component", title: "设置（&section=…）", artboard: "Settings" },
  launch: { kind: "component", title: "启动画面", artboard: "Launch" },
  "launch-error": { kind: "component", title: "启动出错", artboard: "Launch" },
  "launch-waiting": { kind: "component", title: "等待 Docker", artboard: "Launch" },
  welcome: { kind: "component", title: "首次使用", artboard: "Welcome" },
  connect: { kind: "component", title: "连接服务电脑", artboard: "Connect" },
  login: { kind: "component", title: "登录", artboard: "Login" },
  model: { kind: "component", title: "选择模型", artboard: "ModelSetup" },
  worker: { kind: "component", title: "工作电脑（可选）", artboard: "WorkerSetup" },
};

const name = new URLSearchParams(location.search).get("scene") ?? "";
// &theme=dark previews the dark appearance; without it the preview stays light, so captures do not
// depend on the machine's own setting.
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.colorScheme = theme;
const scene = scenes[name];
const world = createWorld(scene?.kind === "app" ? (scene.world ?? "full") : "full");
const storage = installPreviewTransport(world);
if (scene?.kind === "app")
  storage.setItem(
    "openbot.workspace-preferences.v1",
    JSON.stringify({
      rightPanelOpen: scene.rail ?? true,
      // &sidebar=0 shows the collapsed sidebar (the legacy-style sweep covers both).
      leftPanelOpen: new URLSearchParams(location.search).get("sidebar") !== "0",
      colorScheme: theme,
    }),
  );

const [{ createRoot }, { renderScene }] = await Promise.all([
  import("react-dom/client"),
  import("./scenes"),
]);
const root = document.getElementById("root");
if (!root) throw new Error("Preview root is missing.");
createRoot(root).render(renderScene(name, scene, scenes));
