import { installPreviewTransport } from "./transport";
import { createWorld } from "./world";
import "../global-styles";
import "./preview.css";

/*
 * Design preview entry (dev only): `npm run design:preview -w @openbot/web`, then open
 * http://127.0.0.1:5179/preview.html?scene=<name>. Each scene renders the real product UI on the
 * synthetic world so it can be screenshotted next to its artboard at 1440×900.
 */

type AppScene = {
  kind: "app";
  title: string;
  artboard: string;
  world?: "full" | "empty";
  start?:
    | { kind: "home" }
    | { kind: "new" }
    | { kind: "work" }
    | { kind: "channel"; id: string }
    | { kind: "employee"; id: string; tab: "overview" };
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
  profile: {
    kind: "app",
    title: "Bot 档案",
    artboard: "Profile",
    start: { kind: "employee", id: "b-research", tab: "overview" },
    rail: true,
  },
  new: { kind: "app", title: "新建聊天", artboard: "New", start: { kind: "new" } },
  work: { kind: "app", title: "任务监督", artboard: "WorkSupervision", start: { kind: "work" } },
  empty: {
    kind: "app",
    title: "空工作区",
    artboard: "EmptyWorkspace",
    world: "empty",
    start: { kind: "home" },
  },
  avatars: { kind: "component", title: "头像系统 v3", artboard: "Avatars" },
  groups: { kind: "component", title: "群组头像", artboard: "GroupAvatars" },
  launch: { kind: "component", title: "启动画面", artboard: "Launch" },
  "launch-error": { kind: "component", title: "启动出错", artboard: "Launch" },
  welcome: { kind: "component", title: "首次使用", artboard: "Welcome" },
  connect: { kind: "component", title: "连接服务电脑", artboard: "Connect" },
  login: { kind: "component", title: "登录", artboard: "Login" },
  model: { kind: "component", title: "选择模型", artboard: "ModelSetup" },
  worker: { kind: "component", title: "工作电脑（可选）", artboard: "WorkerSetup" },
};

const name = new URLSearchParams(location.search).get("scene") ?? "";
const scene = scenes[name];
const world = createWorld(scene?.kind === "app" ? (scene.world ?? "full") : "full");
const storage = installPreviewTransport(world);
if (scene?.kind === "app")
  storage.setItem(
    "openbot.workspace-preferences.v1",
    JSON.stringify({ rightPanelOpen: scene.rail ?? true, leftPanelOpen: true }),
  );

const [{ createRoot }, { renderScene }] = await Promise.all([
  import("react-dom/client"),
  import("./scenes"),
]);
const root = document.getElementById("root");
if (!root) throw new Error("Preview root is missing.");
createRoot(root).render(renderScene(name, scene, scenes));
