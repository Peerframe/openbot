// @vitest-environment jsdom
import type { ExecutionNode, NodeIdentitySummary } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interact, renderComponent, type RenderedComponent } from "../test/render-component";
import * as api from "../api";
import { NodeIdentityList, NodeManagerDialog, nodeIdentityDisplayState } from "./NodeManagerDialog";

const identity: NodeIdentitySummary = {
  nodeId: "office-linux-01",
  status: "active",
  connected: false,
  enrolledAt: "2026-09-04T00:00:00.000Z",
};

const node: ExecutionNode = {
  id: identity.nodeId,
  name: "Office Linux",
  status: "online",
  platform: "linux",
  osVersion: "6.8",
  architecture: "x64",
  deviceClass: "server",
  isolation: "container",
  trustTier: "dedicated",
  capabilities: ["browser"],
  capabilityManifest: [
    { id: "browser.navigate", version: 1, providerId: "browser-driver", constraints: {} },
  ],
  maxConcurrentRuns: 1,
  activeRunIds: [],
  connectedAt: "2026-09-04T00:00:00.000Z",
  lastSeenAt: "2026-09-04T00:01:00.000Z",
};

describe("NodeManagerDialog", () => {
  it("derives live state from the realtime Node projection and lets revocation win", () => {
    expect(nodeIdentityDisplayState(identity, [node])).toBe("online");
    expect(nodeIdentityDisplayState(identity, [])).toBe("offline");
    expect(nodeIdentityDisplayState({ ...identity, status: "revoked" }, [node])).toBe("revoked");
  });

  it("renders platform evidence and requires a second destructive action", () => {
    const html = renderToStaticMarkup(
      <NodeIdentityList
        identities={[identity]}
        onlineNodes={[node]}
        confirmingNodeId={identity.nodeId}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onRevoke={() => undefined}
      />,
    );

    expect(html).toContain("Office Linux");
    expect(html).toContain("Linux · x64");
    expect(html).toContain("在线");
    expect(html).toContain("旧凭证将立即失效");
    expect(html).toContain("确认吊销");
  });
});


vi.mock("../api", () => ({
  listNodeIdentities: vi.fn(),
  createNodeEnrollmentToken: vi.fn(),
  revokeNodeIdentity: vi.fn(),
}));

const modalViews: RenderedComponent[] = [];

function NodeManagerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        管理工作主机
      </button>
      {open ? <NodeManagerDialog onlineNodes={[node]} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

beforeEach(() => {
  vi.mocked(api.listNodeIdentities).mockResolvedValue([identity]);
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

afterEach(async () => {
  for (const view of modalViews.splice(0)) await view.unmount();
  vi.clearAllMocks();
});


describe("NodeManagerDialog modal lifecycle", () => {
  it("calls showModal, keeps revoke confirmation copy, and unmounts on cancel", async () => {
    const view = await renderComponent(<NodeManagerHarness />);
    modalViews.push(view);
    const opener = view.container.querySelector<HTMLButtonElement>("button");
    if (!opener) throw new Error("No opener");
    await interact(() => {
      opener.focus();
      opener.click();
    });
    // Flush listNodeIdentities resolution into React state.
    await interact(() => undefined);
    await Promise.resolve();
    await interact(() => undefined);

    const dialog = view.container.querySelector<HTMLDialogElement>("dialog");
    if (!dialog) throw new Error("No dialog");

    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-labelledby")).toBe("node-manager-title");
    expect(dialog.querySelector('[aria-label="关闭"]')).not.toBeNull();
    expect(api.listNodeIdentities).toHaveBeenCalled();
    expect(view.container.textContent).toContain("Office Linux");

    await interact(() =>
      [...view.container.querySelectorAll("button")]
        .find((button) => button.textContent === "吊销")
        ?.click(),
    );
    expect(view.container.textContent).toContain("旧凭证将立即失效");
    expect(view.container.textContent).toContain("确认吊销");

    await interact(() => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(view.container.querySelector("dialog")).toBeNull();
  });
});
