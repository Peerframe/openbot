import type { Artifact, Bot, Channel, ExecutionNode, Run } from "@openbot/domain";
import type { ReactElement } from "react";
import { App } from "../App";
import { DeleteIdentityDialog } from "../components/DeleteIdentityDialog";
import { DesktopConnectionScreen } from "../components/DesktopConnectionScreen";
import { DesktopLocalWorkerScreen } from "../components/DesktopLocalWorkerScreen";
import { DesktopSetupScreen } from "../components/DesktopSetupScreen";
import { ExportEmployeeDialog } from "../components/ExportEmployeeDialog";
import { ImportEmployeeDialog } from "../components/ImportEmployeeDialog";
import { LoginScreen } from "../components/LoginScreen";
import { ModelConnectionsDialog } from "../components/ModelConnectionsDialog";
import { ModelSettingsScreen } from "../components/ModelSettingsScreen";
import { NodeManagerDialog } from "../components/NodeManagerDialog";
import { LaunchScreen } from "../components/Onboarding";
import { ShareConversationDialog } from "../components/ShareConversationDialog";
import { setPreviewStartLocation, type WorkspaceLocation } from "../workspace-navigation";
import { AvatarSpecimens, GroupSpecimens } from "./AvatarSpecimens";
import type { scenes as sceneTable } from "./main";
import { createWorld } from "./world";

type Scenes = typeof sceneTable;
type Scene = Scenes[string];

// Actions in component scenes stay pending: the preview shows states, it never submits anything.
const pending = () => new Promise<never>(() => undefined);
const close = () => undefined;
// Dialog scenes read the same synthetic world the transport serves.
const world = createWorld() as unknown as {
  bots: Bot[];
  channels: Channel[];
  runs: Run[];
  artifacts: Artifact[];
  nodes: ExecutionNode[];
};
const researcher = world.bots[0] as Bot;
const market = world.channels[0] as Channel;

const components: Record<string, () => ReactElement> = {
  "dialog-share": () => (
    <ShareConversationDialog
      channel={market}
      bots={world.bots}
      artifacts={world.artifacts}
      runs={world.runs}
      onShareBot={close}
      onClose={close}
    />
  ),
  "dialog-export": () => (
    <ExportEmployeeDialog employee={researcher} onClose={close} onDownloaded={close} />
  ),
  "dialog-import": () => <ImportEmployeeDialog onClose={close} onActivated={close} />,
  "dialog-delete": () => (
    <DeleteIdentityDialog
      target={{ kind: "bot", id: researcher.id, name: researcher.name }}
      bots={world.bots}
      channels={world.channels}
      onClose={close}
      onDelete={pending}
    />
  ),
  "dialog-pair": () => <NodeManagerDialog onlineNodes={world.nodes} onClose={close} />,
  "dialog-model": () => <ModelConnectionsDialog onClose={close} onChanged={close} />,
  avatars: () => <AvatarSpecimens />,
  groups: () => <GroupSpecimens />,
  launch: () => <LaunchScreen status="正在打开你的工作区" />,
  "launch-error": () => (
    <LaunchScreen
      error="没能启动本机服务。请确认钥匙串可以访问后重试；已有的 Bot、对话和设置都不会丢。"
      actions={
        <>
          <button className="ob-setup-primary" type="button">
            重试
          </button>
          <button className="ob-setup-secondary" type="button">
            更改连接方式
          </button>
        </>
      }
    />
  ),
  welcome: () => (
    <DesktopSetupScreen
      state={{ status: "unconfigured" }}
      platform="darwin"
      arch="arm64"
      onSave={pending}
    />
  ),
  connect: () => (
    <DesktopConnectionScreen
      connection={{ status: "unconfigured" }}
      onConfigure={pending}
      onChangePlan={() => undefined}
    />
  ),
  login: () => <LoginScreen progress onLogin={pending} />,
  model: () => <ModelSettingsScreen onboarding progress onDone={() => undefined} />,
  worker: () => (
    <DesktopLocalWorkerScreen
      state={{ status: "requires-approval" } as never}
      onContinue={() => undefined}
      onEnable={pending}
      onOpenSettings={pending}
      onRefresh={pending}
      onSetup={pending}
    />
  ),
};

export function renderScene(name: string, scene: Scene | undefined, all: Scenes): ReactElement {
  if (!scene) return <SceneIndex scenes={all} />;
  if (scene.kind === "app") {
    setPreviewStartLocation(scene.start as WorkspaceLocation | undefined);
    return <App />;
  }
  const render = components[name];
  return render ? render() : <SceneIndex scenes={all} />;
}

function SceneIndex({ scenes }: { scenes: Scenes }) {
  return (
    <main className="design-preview-index">
      <h1>设计预览</h1>
      <p>真实界面 + 模拟数据，只在开发时使用。每个场景对应一个画板，按 1440×900 截图对比。</p>
      <ul>
        {Object.entries(scenes).map(([id, scene]) => (
          <li key={id}>
            <a href={`?scene=${id}`}>{scene.title}</a>
            <span>画板 {scene.artboard}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
