// @vitest-environment jsdom
import type { Approval } from "@openbot/domain";
import { expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { ApprovalStack } from "./ApprovalStack";

const approval = (id: string, minutes: number): Approval => ({
  id,
  runId: `run-${id}`,
  channelId: "c",
  botId: "b",
  nodeId: "n",
  action: "email.send",
  target: `${id}@example.com`,
  summary: `发送邮件 ${id}`,
  risk: "write",
  targetFingerprint: "f",
  beforeState: {},
  status: "pending",
  expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
  createdAt: new Date().toISOString(),
});

it("puts the soonest expiry on top, stacks the rest, and opens them on request", async () => {
  const view = await renderComponent(
    <ApprovalStack
      approvals={[approval("late", 30), approval("soon", 3), approval("middle", 10)]}
      botFor={() => undefined}
      channelFor={() => undefined}
      onDecide={vi.fn(async () => undefined)}
    />,
  );
  const stack = view.container.querySelector(".ci-approvals");
  expect(stack?.className).toContain("is-stacked");
  expect(stack?.getAttribute("data-behind")).toBe("2");
  expect(stack?.textContent).toContain("soon@example.com");
  expect(stack?.textContent).not.toContain("late@example.com");
  const toggle = view.container.querySelector<HTMLButtonElement>(".ci-more");
  expect(toggle?.textContent).toBe("展开另外 2 个 ›");
  await interact(() => toggle?.click());
  const order = [...view.container.querySelectorAll(".ci-approvals > *")].map(
    (card) => card.textContent?.match(/(soon|middle|late)@/)?.[1],
  );
  expect(order).toEqual(["soon", "middle", "late"]);
  expect(toggle?.textContent).toBe("收起");
  await view.unmount();
});
