// @vitest-environment jsdom
import type { Bot } from "@openbot/domain";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin, PluginManifest } from "../plugin-api";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { PluginGrantEditor, PluginInstallForm, PluginToolList } from "./PluginManagerPanel";

const manifest: PluginManifest = {
  name: "Example",
  endpoint: "https://example.com/mcp",
  digest: "a".repeat(64),
  tools: [
    {
      name: "write",
      description: "<img src=x onerror=alert(1)>",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
  ],
};
const plugin: Plugin = {
  ...manifest,
  id: "p",
  revision: "revision",
  enabled: false,
  grants: [],
  createdAt: "2026-09-10T00:00:00Z",
};
const bot: Bot = {
  id: "bot",
  name: "Researcher",
  role: "research",
  status: "idle",
  computerProfile: "none",
  createdAt: plugin.createdAt,
};
afterEach(() => vi.unstubAllGlobals());

describe("plugin Owner management", () => {
  it("requires reviewed declarations and invalidates review when the endpoint changes", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => manifest });
    vi.stubGlobal("fetch", fetcher);
    const view = await renderComponent(<PluginInstallForm onInstalled={vi.fn()} />);
    try {
      const inputs = view.container.querySelectorAll<HTMLInputElement>("input");
      if (!inputs[0] || !inputs[1]) throw new Error("Plugin inputs missing");
      await setInputValue(inputs[0], "Example");
      await setInputValue(inputs[1], manifest.endpoint);
      await interact(() =>
        view.container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      const install = Array.from(view.container.querySelectorAll("button")).find(
        (button) => button.textContent === "安装为停用状态",
      );
      expect(install?.disabled).toBe(true);
      await interact(() =>
        view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click(),
      );
      expect(install?.disabled).toBe(false);
      await setInputValue(inputs[1], "https://other.example/mcp");
      expect(view.container.querySelector('input[type="checkbox"]')).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await view.unmount();
    }
  });

  it("submits the exact reviewed digest without granting or enabling tools", async () => {
    const installed = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => manifest })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ plugin }) });
    vi.stubGlobal("fetch", fetcher);
    const view = await renderComponent(<PluginInstallForm onInstalled={installed} />);
    try {
      const inputs = view.container.querySelectorAll<HTMLInputElement>("input");
      if (!inputs[0] || !inputs[1]) throw new Error("Plugin inputs missing");
      await setInputValue(inputs[0], "Example");
      await setInputValue(inputs[1], manifest.endpoint);
      await interact(() =>
        view.container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await interact(() =>
        view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click(),
      );
      await interact(() =>
        Array.from(view.container.querySelectorAll("button"))
          .find((button) => button.textContent === "安装为停用状态")
          ?.click(),
      );
      expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({
        name: "Example",
        endpoint: manifest.endpoint,
        reviewedDigest: manifest.digest,
      });
      expect(installed).toHaveBeenCalledTimes(1);
    } finally {
      await view.unmount();
    }
  });

  it("does not authorize from annotations and escapes plugin descriptions", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const view = await renderComponent(
      <>
        <PluginToolList tools={plugin.tools} />
        <PluginGrantEditor plugin={plugin} bots={[bot]} disabled={false} onSave={save} />
      </>,
    );
    try {
      expect(view.container.querySelector("img")).toBeNull();
      expect(view.container.textContent).toContain("<img src=x onerror=alert(1)>");
      const permission = view.container.querySelector<HTMLSelectElement>(
        '[aria-label="write 调用权限"]',
      );
      if (!permission) throw new Error("Permission select missing");
      expect(permission.value).toBe("none");
      await interact(() => {
        permission.value = "confirm";
        permission.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await interact(() =>
        view.container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(save).toHaveBeenCalledWith(bot.id, [{ name: "write", mode: "confirm" }], {
        resources: [],
        prompts: [],
      });
    } finally {
      await view.unmount();
    }
  });
});

async function renderGrantEditor(element: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    async rerender(next: ReactNode) {
      await act(async () => {
        root.render(next);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("plugin grant Bot selection", () => {
  const received: Bot = {
    id: "received",
    name: "Received",
    role: "research",
    status: "idle",
    computerProfile: "none",
    createdAt: plugin.createdAt,
  };
  const source: Bot = {
    id: "source",
    name: "Source",
    role: "research",
    status: "idle",
    computerProfile: "none",
    createdAt: plugin.createdAt,
  };

  it("keeps the selected Bot and saved grants after a revision bump reload", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const base: Plugin = {
      ...plugin,
      tools: [
        { name: "write", description: "Write", inputSchema: { type: "object" } },
        { name: "read", description: "Read", inputSchema: { type: "object" } },
      ],
      grants: [],
    };
    const view = await renderGrantEditor(
      <PluginGrantEditor plugin={base} bots={[received, source]} disabled={false} onSave={save} />,
    );
    try {
      const botSelect = view.container.querySelector<HTMLSelectElement>(
        '[aria-label="Example 接收 Bot"]',
      );
      if (!botSelect) throw new Error("Bot select missing");
      expect(botSelect.value).toBe(received.id);
      await interact(() => {
        botSelect.value = source.id;
        botSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const permission = view.container.querySelector<HTMLSelectElement>(
        '[aria-label="write 调用权限"]',
      );
      if (!permission) throw new Error("Permission select missing");
      await interact(() => {
        permission.value = "confirm";
        permission.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await interact(() =>
        view.container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(save).toHaveBeenCalledWith(source.id, [{ name: "write", mode: "confirm" }], {
        resources: [],
        prompts: [],
      });
      // Simulate post-save plugin reload (new revision + persisted grants) without remounting.
      const reloaded: Plugin = {
        ...base,
        revision: "revision-after-save",
        grants: [
          {
            botId: source.id,
            tools: [{ name: "write", mode: "confirm" }],
            resources: [],
            prompts: [],
          },
        ],
      };
      await view.rerender(
        <PluginGrantEditor
          plugin={reloaded}
          bots={[received, source]}
          disabled={false}
          onSave={save}
        />,
      );
      expect(botSelect.value).toBe(source.id);
      expect(
        view.container.querySelector<HTMLSelectElement>('[aria-label="write 调用权限"]')?.value,
      ).toBe("confirm");
      expect(view.container.textContent).not.toContain("（Bot 已不存在）");
    } finally {
      await view.unmount();
    }
  });

  it("does not show another Bot empty grants when the selected Bot disappears", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const withGrants: Plugin = {
      ...plugin,
      grants: [
        {
          botId: source.id,
          tools: [{ name: "write", mode: "read" }],
          resources: [],
          prompts: [],
        },
        {
          botId: received.id,
          tools: [],
          resources: [],
          prompts: [],
        },
      ],
    };
    const view = await renderGrantEditor(
      <PluginGrantEditor
        plugin={withGrants}
        bots={[received, source]}
        disabled={false}
        onSave={save}
      />,
    );
    try {
      const botSelect = view.container.querySelector<HTMLSelectElement>(
        '[aria-label="Example 接收 Bot"]',
      );
      if (!botSelect) throw new Error("Bot select missing");
      await interact(() => {
        botSelect.value = source.id;
        botSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(
        view.container.querySelector<HTMLSelectElement>('[aria-label="write 调用权限"]')?.value,
      ).toBe("read");
      await view.rerender(
        <PluginGrantEditor plugin={withGrants} bots={[received]} disabled={false} onSave={save} />,
      );
      expect(botSelect.value).toBe(source.id);
      expect(view.container.textContent).toContain("（Bot 已不存在）");
      expect(
        view.container.querySelector<HTMLSelectElement>('[aria-label="write 调用权限"]')?.value,
      ).toBe("none");
      expect(
        view.container.querySelector<HTMLSelectElement>('[aria-label="write 调用权限"]')?.disabled,
      ).toBe(true);
      expect(
        view.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
      ).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it("drops grant targets that disappeared after a plugin update", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const before: Plugin = {
      ...plugin,
      tools: [
        { name: "write", description: "Write", inputSchema: { type: "object" } },
        { name: "gone", description: "Gone", inputSchema: { type: "object" } },
      ],
      resources: [{ uri: "notes://current", name: "Notes", description: "Read" }],
      prompts: [{ name: "review", description: "Review", arguments: [] }],
      grants: [
        {
          botId: bot.id,
          tools: [
            { name: "write", mode: "confirm" },
            { name: "gone", mode: "read" },
          ],
          resources: ["notes://current", "notes://missing"],
          prompts: ["review", "missing-prompt"],
        },
      ],
    };
    const view = await renderGrantEditor(
      <PluginGrantEditor plugin={before} bots={[bot]} disabled={false} onSave={save} />,
    );
    try {
      expect(
        view.container.querySelector<HTMLSelectElement>('[aria-label="write 调用权限"]')?.value,
      ).toBe("confirm");
      expect(view.container.querySelector('[aria-label="gone 调用权限"]')).toBeTruthy();
      const after: Plugin = {
        ...before,
        revision: "after-update",
        tools: [{ name: "write", description: "Write", inputSchema: { type: "object" } }],
        resources: [{ uri: "notes://current", name: "Notes", description: "Read" }],
        prompts: [{ name: "review", description: "Review", arguments: [] }],
        grants: [
          {
            botId: bot.id,
            tools: [
              { name: "write", mode: "confirm" },
              { name: "gone", mode: "read" },
            ],
            resources: ["notes://current", "notes://missing"],
            prompts: ["review", "missing-prompt"],
          },
        ],
      };
      await view.rerender(
        <PluginGrantEditor plugin={after} bots={[bot]} disabled={false} onSave={save} />,
      );
      expect(view.container.querySelector('[aria-label="gone 调用权限"]')).toBeNull();
      expect(
        view.container.querySelector<HTMLSelectElement>('[aria-label="write 调用权限"]')?.value,
      ).toBe("confirm");
      await interact(() =>
        view.container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(save).toHaveBeenCalledWith(bot.id, [{ name: "write", mode: "confirm" }], {
        resources: ["notes://current"],
        prompts: ["review"],
      });
    } finally {
      await view.unmount();
    }
  });
});
