// @vitest-environment jsdom
import type { Run, RunProgress, RunProgressDetails } from "@openbot/domain";
import { beforeEach, expect, it, vi } from "vitest";
import { getRunProgress } from "../api";
import { interact, renderComponent } from "../test/render-component";
import { hiddenStepNumbers, TaskSteps } from "./TaskSteps";

vi.mock("../api", () => ({ getRunProgress: vi.fn() }));

const run = { id: "run-1", status: "running" } as Run;
const event = (index: number): RunProgress => ({
  id: `p${index}`,
  runId: run.id,
  channelId: "c",
  stage: "planning",
  message: `第 ${index} 条`,
  createdAt: new Date(Date.UTC(2026, 9, 3, 0, index)).toISOString(),
});
const step = (stepNumber: number) => ({
  id: `s${stepNumber}`,
  stepNumber,
  stageName: "navigate",
  description: "Open a page.",
  startedAt: null,
  endedAt: null,
});
const details = (total: number, numbers: number[]): RunProgressDetails => ({
  runId: run.id,
  status: "running",
  totalSteps: total,
  currentStepNumber: total,
  plannedTotalSteps: null,
  completedSteps: null,
  stageName: null,
  description: null,
  startedAt: null,
  endedAt: null,
  failureReasonCode: null,
  steps: numbers.map(step),
});
async function render(progress: RunProgress[]) {
  return renderComponent(
    <ol>
      <TaskSteps run={run} progress={progress} />
    </ol>,
  );
}
const numbers = (container: HTMLElement) =>
  [...container.querySelectorAll("li small")].map((item) => item.textContent);

beforeEach(() => vi.mocked(getRunProgress).mockReset());

it("knows which middle steps are folded", () => {
  expect(hiddenStepNumbers(12, new Set())).toEqual([]);
  expect(hiddenStepNumbers(15, new Set([1, 2, 3, 10, 11, 12, 13, 14, 15]))).toEqual([
    4, 5, 6, 7, 8, 9,
  ]);
});

it("folds the 服务电脑's long step list and reads the middle on 展开", async () => {
  vi.mocked(getRunProgress)
    .mockResolvedValueOnce(details(20, [1, 2, 3, 15, 16, 17, 18, 19, 20]))
    .mockResolvedValueOnce(details(20, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]));
  const view = await render([]);
  await interact(async () => undefined);
  expect(numbers(view.container)).toHaveLength(9);
  const fold = view.container.querySelector(".task-sheet-fold button") as HTMLButtonElement;
  expect(fold.textContent).toBe("展开 11 步");
  // The fold sits between step 3 and step 15.
  expect(fold.closest("li")?.previousElementSibling?.textContent).toContain("第 3 步");
  // The stage shows by its Chinese name, never the 服务电脑's English description.
  expect(view.container.textContent).toContain("打开网页");
  expect(view.container.textContent).not.toContain("Open a page.");
  await interact(() => fold.click());
  expect(getRunProgress).toHaveBeenLastCalledWith(run.id, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  expect(numbers(view.container)).toHaveLength(20);
  expect(view.container.querySelector(".task-sheet-fold")).toBeNull();
  await view.unmount();
});

it("folds the workspace's own progress the same way when the count is unavailable", async () => {
  // An older 服务电脑 has no count to give.
  vi.mocked(getRunProgress).mockResolvedValue(details(0, []));
  const view = await render(Array.from({ length: 15 }, (_, index) => event(index + 1)));
  await interact(async () => undefined);
  expect(numbers(view.container)).toEqual([
    "第 1 条",
    "第 2 条",
    "第 3 条",
    "第 10 条",
    "第 11 条",
    "第 12 条",
    "第 13 条",
    "第 14 条",
    "第 15 条",
  ]);
  await interact(() =>
    (view.container.querySelector(".task-sheet-fold button") as HTMLButtonElement).click(),
  );
  expect(numbers(view.container)).toHaveLength(15);
  await view.unmount();
});
