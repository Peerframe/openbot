import type { DesktopSetupMode, DesktopSetupPlanInput } from "./desktop-runtime";

export const MAXIMUM_PLANNED_WORKER_COMPUTERS = 100;

export const desktopSetupModes: readonly Readonly<{
  description: string;
  mode: DesktopSetupMode;
  title: string;
}>[] = Object.freeze([
  Object.freeze({
    mode: "client",
    title: "只使用 OpenBot",
    description: "把这台电脑作为日常客户端，连接一个已经存在的服务电脑。",
  }),
  Object.freeze({
    mode: "client-worker",
    title: "使用并参与工作",
    description: "这台电脑既能正常使用 OpenBot，也计划安装 工作电脑服务 执行任务。",
  }),
  Object.freeze({
    mode: "host",
    title: "在这里托管 OpenBot",
    description: "计划在这台电脑运行服务电脑；可同时让它成为一台工作电脑。",
  }),
  Object.freeze({
    mode: "advanced",
    title: "高级自部署",
    description: "自行拆分部署服务电脑与工作电脑，再通过 Desktop 或 Web 连接。",
  }),
]);

export interface DesktopSetupChecklistRow {
  detail: string;
  id: string;
  label: string;
  state: "当前" | "下一步" | "计划";
}

export function createDesktopSetupPlanInput(input: DesktopSetupPlanInput): DesktopSetupPlanInput {
  if (!desktopSetupModes.some(({ mode }) => mode === input.mode)) {
    throw new Error("Unsupported Desktop setup mode.");
  }
  if (
    !Number.isInteger(input.plannedWorkerCount) ||
    input.plannedWorkerCount < 0 ||
    input.plannedWorkerCount > MAXIMUM_PLANNED_WORKER_COMPUTERS
  ) {
    throw new Error("Invalid planned Worker count.");
  }
  if (input.mode === "client" && (input.localWorker || input.plannedWorkerCount !== 0)) {
    throw new Error("Client-only setup cannot plan Workers.");
  }
  if (input.mode === "client-worker" && (!input.localWorker || input.plannedWorkerCount < 1)) {
    throw new Error("Client and Worker setup must include this computer.");
  }
  if (input.mode === "advanced" && input.localWorker) {
    throw new Error("Advanced setup does not manage a local Worker.");
  }
  if (input.localWorker && input.plannedWorkerCount < 1) {
    throw new Error("The local Worker must be included in the planned count.");
  }
  return Object.freeze({ ...input });
}

export function desktopSetupModeTitle(mode: DesktopSetupMode): string {
  return desktopSetupModes.find((option) => option.mode === mode)?.title ?? "安装计划";
}

export function deriveDesktopSetupChecklist(
  input: DesktopSetupPlanInput,
): readonly DesktopSetupChecklistRow[] {
  const plan = createDesktopSetupPlanInput(input);
  const rows: DesktopSetupChecklistRow[] = [
    Object.freeze({
      id: "desktop-client",
      label: "这台电脑：OpenBot Desktop",
      detail: "Desktop 已打开；即使它以后承担工作任务，也仍然可以作为你的使用电脑。",
      state: "当前",
    }),
  ];
  if (plan.mode === "host") {
    rows.push(
      Object.freeze({
        id: "server-install",
        label: "在这台电脑安装 OpenBot 服务电脑",
        detail: "自动 服务电脑与数据库 安装器尚未交付；保存计划不会执行安装。",
        state: "计划",
      }),
    );
  } else if (plan.mode === "advanced") {
    rows.push(
      Object.freeze({
        id: "manual-deployment",
        label: "独立部署服务电脑与服务",
        detail: "按自部署文档完成服务；Desktop 不是必需组件，Web 也可以完整使用。",
        state: "计划",
      }),
    );
  }
  rows.push(
    Object.freeze({
      id: "server-connect",
      label: "连接唯一的 OpenBot 服务电脑",
      detail: "验证服务电脑地址并确认后，所有频道、权限、审批和审计仍由服务电脑负责。",
      state: "下一步",
    }),
  );

  if (plan.localWorker) {
    rows.push(
      Object.freeze({
        id: "local-worker",
        label: "工作电脑 1：这台电脑",
        detail: "后续安装 工作电脑服务 并绑定服务电脑；当前只是计划，尚未登记或授权。",
        state: "计划",
      }),
    );
  }
  const remoteWorkers = plan.plannedWorkerCount - Number(plan.localWorker);
  for (let index = 0; index < remoteWorkers; index += 1) {
    const workerNumber = index + 1 + Number(plan.localWorker);
    rows.push(
      Object.freeze({
        id: `remote-worker-${workerNumber}`,
        label: `工作电脑 ${workerNumber}`,
        detail: "安装同一个 OpenBot Desktop，选择作为工作电脑，再通过服务电脑完成绑定。",
        state: "计划",
      }),
    );
  }
  return Object.freeze(rows);
}
