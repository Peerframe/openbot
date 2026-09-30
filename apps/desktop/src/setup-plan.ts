import type { DesktopSetupMode, DesktopSetupPlanInput } from "@openbot/protocol";
export type { DesktopSetupMode, DesktopSetupPlanInput } from "@openbot/protocol";
import { RestrictedJsonFile } from "./restricted-json-file.js";

export const DESKTOP_SETUP_PLAN_FORMAT = "openbot.desktop-setup-plan/v1" as const;
export const MAXIMUM_DESKTOP_SETUP_PLAN_BYTES = 4 * 1024;
export const MAXIMUM_PLANNED_WORKER_COMPUTERS = 100;
export const DESKTOP_SETUP_MODES = ["client", "client-worker", "host", "advanced"] as const;

export interface DesktopSetupPlan extends DesktopSetupPlanInput {
  format: typeof DESKTOP_SETUP_PLAN_FORMAT;
}

export interface DesktopSetupPlanStore {
  load(): Promise<DesktopSetupPlan | undefined>;
  save(plan: DesktopSetupPlan): Promise<void>;
}

export type DesktopSetupChecklistKind =
  | "desktop-client"
  | "server-connect"
  | "server-install"
  | "manual-deployment"
  | "local-worker"
  | "remote-worker";

export interface DesktopSetupChecklistItem {
  id: string;
  kind: DesktopSetupChecklistKind;
  workerNumber?: number;
}

export function createDesktopSetupPlan(input: unknown): DesktopSetupPlan {
  if (!isRecord(input)) throw new Error("Desktop setup plan input must be an object.");
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "localWorker" ||
    keys[1] !== "mode" ||
    keys[2] !== "plannedWorkerCount"
  ) {
    throw new Error("Desktop setup plan input contains unknown fields.");
  }
  return parseDesktopSetupPlan(
    JSON.stringify({
      format: DESKTOP_SETUP_PLAN_FORMAT,
      localWorker: input.localWorker,
      mode: input.mode,
      plannedWorkerCount: input.plannedWorkerCount,
    }),
  );
}

export function parseDesktopSetupPlan(input: string): DesktopSetupPlan {
  if (Buffer.byteLength(input) > MAXIMUM_DESKTOP_SETUP_PLAN_BYTES) {
    throw new Error("Desktop setup plan exceeds the 4 KiB limit.");
  }

  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("Desktop setup plan must be valid JSON.");
  }
  if (!isRecord(value)) throw new Error("Desktop setup plan must be an object.");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "format" ||
    keys[1] !== "localWorker" ||
    keys[2] !== "mode" ||
    keys[3] !== "plannedWorkerCount"
  ) {
    throw new Error("Desktop setup plan contains unknown fields.");
  }
  if (value.format !== DESKTOP_SETUP_PLAN_FORMAT) {
    throw new Error("Desktop setup plan version is unsupported.");
  }
  if (!DESKTOP_SETUP_MODES.includes(value.mode as DesktopSetupMode)) {
    throw new Error("Desktop setup mode is unsupported.");
  }
  if (
    !Number.isInteger(value.plannedWorkerCount) ||
    (value.plannedWorkerCount as number) < 0 ||
    (value.plannedWorkerCount as number) > MAXIMUM_PLANNED_WORKER_COMPUTERS
  ) {
    throw new Error("Planned Worker computer count is invalid.");
  }
  if (typeof value.localWorker !== "boolean") {
    throw new Error("Local Worker selection is invalid.");
  }

  const mode = value.mode as DesktopSetupMode;
  const plannedWorkerCount = value.plannedWorkerCount as number;
  const localWorker = value.localWorker;
  assertModeInvariants({ localWorker, mode, plannedWorkerCount });
  return Object.freeze({
    format: DESKTOP_SETUP_PLAN_FORMAT,
    localWorker,
    mode,
    plannedWorkerCount,
  });
}

export function toDesktopSetupPlanInput(plan: DesktopSetupPlan): DesktopSetupPlanInput {
  return Object.freeze({
    localWorker: plan.localWorker,
    mode: plan.mode,
    plannedWorkerCount: plan.plannedWorkerCount,
  });
}

export function deriveDesktopSetupChecklist(
  plan: DesktopSetupPlanInput,
): readonly DesktopSetupChecklistItem[] {
  const canonical = createDesktopSetupPlan(plan);
  const items: DesktopSetupChecklistItem[] = [
    Object.freeze({ id: "desktop-client", kind: "desktop-client" }),
  ];
  if (canonical.mode === "host") {
    items.push(Object.freeze({ id: "server-install", kind: "server-install" }));
  } else if (canonical.mode === "advanced") {
    items.push(Object.freeze({ id: "manual-deployment", kind: "manual-deployment" }));
  }
  items.push(Object.freeze({ id: "server-connect", kind: "server-connect" }));

  if (canonical.localWorker) {
    items.push(Object.freeze({ id: "local-worker", kind: "local-worker", workerNumber: 1 }));
  }
  const remoteWorkerCount = canonical.plannedWorkerCount - Number(canonical.localWorker);
  for (let index = 0; index < remoteWorkerCount; index += 1) {
    const workerNumber = index + 1 + Number(canonical.localWorker);
    items.push(
      Object.freeze({
        id: `remote-worker-${workerNumber}`,
        kind: "remote-worker",
        workerNumber,
      }),
    );
  }
  return Object.freeze(items);
}

export class FileDesktopSetupPlanStore implements DesktopSetupPlanStore {
  readonly #file: RestrictedJsonFile<DesktopSetupPlan>;

  constructor(path: string) {
    this.#file = new RestrictedJsonFile(path, {
      label: "Desktop setup plan",
      maximumBytes: MAXIMUM_DESKTOP_SETUP_PLAN_BYTES,
      parse: parseDesktopSetupPlan,
    });
  }

  async load(): Promise<DesktopSetupPlan | undefined> {
    return this.#file.load();
  }

  async save(plan: DesktopSetupPlan): Promise<void> {
    await this.#file.save(plan);
  }
}

function assertModeInvariants(plan: DesktopSetupPlanInput): void {
  if (plan.mode === "client" && (plan.localWorker || plan.plannedWorkerCount !== 0)) {
    throw new Error("Client-only setup cannot plan Worker computers.");
  }
  if (plan.mode === "client-worker" && (!plan.localWorker || plan.plannedWorkerCount < 1)) {
    throw new Error("Client and Worker setup must include this computer.");
  }
  if (plan.mode === "advanced" && plan.localWorker) {
    throw new Error("Advanced self-host setup does not manage this computer as a Worker.");
  }
  if (plan.localWorker && plan.plannedWorkerCount < 1) {
    throw new Error("A local Worker must count as one planned Worker computer.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
