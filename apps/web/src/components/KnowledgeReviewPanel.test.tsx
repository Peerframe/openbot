// @vitest-environment jsdom
import type { KnowledgeProposal } from "@openbot/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getKnowledgeProposals, reviewKnowledgeProposal } from "../api";
import { deferred, interact, renderComponent } from "../test/render-component";
import { KnowledgeProposalReview, KnowledgeReviewPanel } from "./KnowledgeReviewPanel";

vi.mock("../api", () => ({ getKnowledgeProposals: vi.fn(), reviewKnowledgeProposal: vi.fn() }));
const proposal: KnowledgeProposal = {
  id: "proposal",
  botId: "bot",
  sourceRunId: "source-run",
  kind: "procedural",
  title: "Retain evidence",
  content: "Label inference and retain source URLs.",
  createdAt: "2026-09-08T00:00:00Z",
};
beforeEach(() => vi.clearAllMocks());
describe("Owner knowledge review", () => {
  it("shows full proposal and provenance with model use off until deliberately selected", async () => {
    const onReviewed = vi.fn(async () => {});
    const pending = deferred<{ proposalId: string; decision: string; memoryId: string | null }>();
    vi.mocked(reviewKnowledgeProposal).mockReturnValue(pending.promise);
    const view = await renderComponent(
      <KnowledgeProposalReview proposal={proposal} onReviewed={onReviewed} />,
    );
    try {
      expect(view.container.textContent).toContain("source-run");
      expect(view.container.querySelector("textarea")?.value).toBe(proposal.content);
      const checkbox = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(checkbox?.checked).toBe(false);
      await interact(() => checkbox?.click());
      const submit = view.container.querySelector<HTMLButtonElement>('button[type="submit"]');
      await interact(() => submit?.click());
      expect(reviewKnowledgeProposal).toHaveBeenCalledExactlyOnceWith("bot", "proposal", {
        decision: "accept",
        ownerReviewed: true,
        title: proposal.title,
        content: proposal.content,
        modelUseEnabled: true,
      });
      expect(submit?.disabled).toBe(true);
      expect(onReviewed).not.toHaveBeenCalled();
      await interact(() =>
        pending.resolve({ proposalId: "proposal", decision: "accept", memoryId: "memory" }),
      );
      expect(onReviewed).toHaveBeenCalledOnce();
    } finally {
      await view.unmount();
    }
  });
  it("sends no candidate content with rejection and reports uncertain results without automatic retry", async () => {
    vi.mocked(reviewKnowledgeProposal).mockRejectedValue(new Error("PRIVATE RESPONSE"));
    const view = await renderComponent(
      <KnowledgeProposalReview proposal={proposal} onReviewed={async () => {}} />,
    );
    try {
      const reject = [...view.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("拒绝"),
      );
      await interact(() => reject?.click());
      expect(reviewKnowledgeProposal).toHaveBeenCalledExactlyOnceWith("bot", "proposal", {
        decision: "reject",
        ownerReviewed: true,
      });
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("刷新");
      expect(view.container.textContent).not.toContain("PRIVATE");
    } finally {
      await view.unmount();
    }
  });
  it("provides a visible refresh path and does not imply empty data after a failed read", async () => {
    vi.mocked(getKnowledgeProposals).mockRejectedValue(new Error("unavailable"));
    const view = await renderComponent(
      <KnowledgeReviewPanel botId="bot" onChanged={async () => {}} />,
    );
    try {
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("无法读取");
      expect(view.container.textContent).not.toContain("没有待审阅");
      vi.mocked(getKnowledgeProposals).mockResolvedValue([]);
      await interact(() => view.container.querySelector("button")?.click());
      expect(view.container.textContent).toContain("没有待审阅");
    } finally {
      await view.unmount();
    }
  });
});

describe("native Task knowledge provenance", () => {
  const nativeProposal: KnowledgeProposal = {
    id: "native-proposal",
    botId: "bot",
    source: { kind: "task", taskId: "task-identity", runId: "work-run-identity" },
    kind: "procedural",
    title: "Retain native evidence",
    content: "Review before using this memory.",
    createdAt: "2026-09-25T00:00:00Z",
  };
  it("links the actual native Task, separately labels its Work Run, and leaves model use off", async () => {
    const reviewed = vi.fn(async () => {});
    vi.mocked(reviewKnowledgeProposal).mockResolvedValue({
      proposalId: "native-proposal",
      decision: "accept",
      memoryId: "native-memory",
    });
    const view = await renderComponent(
      <KnowledgeProposalReview proposal={nativeProposal} onReviewed={reviewed} />,
    );
    try {
      const source = view.container.querySelector(".knowledge-source");
      expect(source?.textContent).toContain("来源 Task：task-identity");
      expect(source?.textContent).toContain("Work Run：work-run-identity");
      expect(source?.textContent).not.toContain("来源频道 Run");
      const link = source?.querySelector("a");
      expect(link?.getAttribute("href")).toBe("#/tasks?task=task-identity");
      expect(link?.textContent).toBe("task-identity");
      expect(
        view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
      ).toBe(false);
      await interact(() =>
        view.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click(),
      );
      expect(reviewKnowledgeProposal).toHaveBeenCalledExactlyOnceWith("bot", "native-proposal", {
        decision: "accept",
        ownerReviewed: true,
        title: nativeProposal.title,
        content: nativeProposal.content,
        modelUseEnabled: false,
      });
      expect(reviewed).toHaveBeenCalledOnce();
    } finally {
      await view.unmount();
    }
  });
  it("rejects a native proposal without sending or fabricating any source identity", async () => {
    vi.mocked(reviewKnowledgeProposal).mockResolvedValue({
      proposalId: "native-proposal",
      decision: "reject",
      memoryId: null,
    });
    const view = await renderComponent(
      <KnowledgeProposalReview proposal={nativeProposal} onReviewed={async () => {}} />,
    );
    try {
      await interact(() =>
        [...view.container.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("拒绝"))
          ?.click(),
      );
      expect(reviewKnowledgeProposal).toHaveBeenCalledExactlyOnceWith("bot", "native-proposal", {
        decision: "reject",
        ownerReviewed: true,
      });
    } finally {
      await view.unmount();
    }
  });
  it("keeps channel proposals distinct and does not turn a legacy Run into a Task link", async () => {
    const view = await renderComponent(
      <KnowledgeProposalReview proposal={proposal} onReviewed={async () => {}} />,
    );
    try {
      expect(view.container.querySelector(".knowledge-source")?.textContent).toContain(
        "来源频道 Run：source-run",
      );
      expect(view.container.querySelector(".knowledge-source a")).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
