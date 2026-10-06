// @vitest-environment jsdom
import type { ModelConnection } from "@openbot/domain";
import { afterEach, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { TranscriptionConnectionSetting } from "./TranscriptionConnectionSetting";

afterEach(() => vi.unstubAllGlobals());
const connection: ModelConnection = {
  id: "openai-1",
  name: "My OpenAI",
  presetId: "openai",
  baseUrl: "https://api.openai.com/v1",
  protocol: "openai-chat",
  enabled: true,
  hasApiKey: true,
  revision: 1,
  source: "saved",
  createdAt: "2026-10-05T00:00:00Z",
  updatedAt: "2026-10-05T00:00:00Z",
};
it("saves an explicit eligible connection without transferring a key", async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    Response.json(
      init?.method === "PUT"
        ? { revision: 3, connectionId: "openai-1" }
        : { revision: 2, connectionId: null },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const view = await renderComponent(
    <TranscriptionConnectionSetting
      connections={[
        connection,
        { ...connection, id: "off", enabled: false },
        { ...connection, id: "custom", presetId: "custom" },
      ]}
    />,
  );
  const select = view.container.querySelector("select") as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "openai-1"]);
  await interact(() => {
    select.value = "openai-1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await interact(() => view.container.querySelector("button")?.click());
  const call = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
  expect(JSON.parse(call?.[1]?.body as string)).toEqual({
    expectedRevision: 2,
    connectionId: "openai-1",
  });
  expect(view.container.textContent).toContain("已保存语音转写连接");
  await view.unmount();
});
it("keeps unavailable selections visible and allows clearing them", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ revision: 2, connectionId: "deleted" })),
  );
  const view = await renderComponent(<TranscriptionConnectionSetting connections={[]} />);
  expect(view.container.textContent).toContain("转写已暂停");
  expect(view.container.querySelector("select")?.value).toBe("deleted");
  await view.unmount();
});
it("does not report success on conflict and reloads before a retry", async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "PUT"
      ? Response.json({ error: "owner_preferences_revision_conflict" }, { status: 409 })
      : Response.json({ revision: 2, connectionId: null }),
  );
  vi.stubGlobal("fetch", fetch);
  const view = await renderComponent(<TranscriptionConnectionSetting connections={[connection]} />);
  const select = view.container.querySelector("select") as HTMLSelectElement;
  await interact(() => {
    select.value = connection.id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await interact(() => view.container.querySelector("button")?.click());
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("设置已更新");
  expect(view.container.textContent).not.toContain("已保存语音转写连接");
  await interact(() =>
    Array.from(view.container.querySelectorAll("button"))
      .find((b) => b.textContent === "重新读取")
      ?.click(),
  );
  expect(select.value).toBe("");
  await view.unmount();
});
