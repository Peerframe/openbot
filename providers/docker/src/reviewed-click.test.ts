import { describe, expect, it, vi } from "vitest";
import { commitReviewedClick, prepareReviewedClick, reviewedClick } from "./reviewed-click.js";

const target = "https://example.com/";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64");
function fixture(
  overrides: {
    control?: string;
    changed?: boolean;
    ambiguous?: boolean;
    status?: "approved" | "rejected" | "expired";
  } = {},
) {
  const controller = new AbortController();
  const clicks: unknown[] = [];
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (path === "/control") return { holder: overrides.control ?? "bot" };
    if (path === "/snapshot")
      return {
        url: target,
        snapshotId: 3,
        truncated: false,
        elements: Array.from({ length: overrides.ambiguous ? 2 : 1 }, () => ({
          ref: "f2e4",
          role: "button",
          name: "Preview",
        })),
      };
    if (path === "/screenshot")
      return {
        url: target,
        base64: overrides.changed
          ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString("base64")
          : png,
      };
    if (path === "/click") {
      clicks.push(body);
      return { action: "click", ref: "f2e4", url: target };
    }
    throw new Error("Unknown endpoint");
  });
  const requestApproval = vi.fn(async () => ({
    approvalId: "approved-once",
    status: overrides.status ?? "approved",
  }));
  return {
    options: {
      target,
      buttonName: "Preview",
      signal: controller.signal,
      screenshot: { url: target, base64: png },
      request: request as Parameters<typeof reviewedClick>[0]["request"],
      requestApproval,
    },
    request,
    requestApproval,
    clicks,
    controller,
  };
}
describe("reviewed browser click commit", () => {
  it("freezes observed evidence and commits the original ref exactly once", async () => {
    const f = fixture();
    await reviewedClick(f.options);
    expect(f.requestApproval).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "browser.click",
        target,
        risk: "privileged",
        beforeState: expect.objectContaining({ ref: "f2e4", snapshotId: 3, buttonName: "Preview" }),
      }),
    );
    expect(f.clicks).toEqual([{ ref: "f2e4", snapshotId: 3 }]);
  });
  it.each([
    { status: "rejected" as const },
    { status: "expired" as const },
    { changed: true },
    { ambiguous: true },
    { control: "human" },
  ])("does not click when evidence or authority fails: %j", async (overrides) => {
    const f = fixture(overrides);
    await expect(reviewedClick(f.options)).rejects.toThrow();
    expect(f.clicks).toEqual([]);
  });
  it("honors cancellation while awaiting review", async () => {
    const f = fixture();
    f.requestApproval.mockImplementationOnce(async () => {
      f.controller.abort();
      return { approvalId: "late", status: "approved" };
    });
    await expect(reviewedClick(f.options)).rejects.toThrow();
    expect(f.clicks).toEqual([]);
  });
  it("does not retry an uncertain click response", async () => {
    const f = fixture();
    const original = f.options.request;
    f.options.request = async (path, body) => {
      const result = await original(path, body);
      if (path === "/click") throw new Error("Connection lost after commit");
      return result;
    };
    await expect(reviewedClick(f.options)).rejects.toThrow("it may have occurred");
    expect(f.clicks).toHaveLength(1);
  });
});

it("consumes a prepared handle before an uncertain dispatch and forbids replay", async () => {
  const f = fixture();
  const original = f.options.request;
  f.options.request = async (path, body) => {
    const result = await original(path, body);
    if (path === "/click") throw new Error("Connection lost after commit");
    return result;
  };
  const prepared = await prepareReviewedClick(f.options);
  expect(f.requestApproval).not.toHaveBeenCalled();
  const approval = { approvalId: "once", status: "approved" as const };
  await expect(commitReviewedClick(prepared, approval)).rejects.toThrow("it may have occurred");
  await expect(commitReviewedClick(prepared, approval)).rejects.toThrow("already consumed");
  expect(f.clicks).toHaveLength(1);
});
it("does not accept a reconstructed or mutated preparation as a commit handle", async () => {
  const f = fixture();
  const prepared = await prepareReviewedClick(f.options);
  expect(Object.isFrozen(prepared.action)).toBe(true);
  expect(Object.isFrozen(prepared.action.beforeState)).toBe(true);
  await expect(
    commitReviewedClick({ action: prepared.action }, { approvalId: "copied", status: "approved" }),
  ).rejects.toThrow("invalid");
  expect(f.clicks).toHaveLength(0);
});
