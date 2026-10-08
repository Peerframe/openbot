// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { PrimaryBotSetting, primaryBotChangedEvent } from "./PrimaryBotSetting";

afterEach(() => vi.unstubAllGlobals());
const snapshot = { primaryBotId: null, revision: 1, bots: [{ id: "bot-1", name: "协调员" }] };
it("prompts when unselected and saves the Server revision without permission fields", async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    Response.json(init?.method === "PUT" ? { primaryBotId: "bot-1", revision: 2 } : snapshot),
  );
  vi.stubGlobal("fetch", fetch);
  const changed = vi.fn();
  window.addEventListener(primaryBotChangedEvent, changed);
  const view = await renderComponent(<PrimaryBotSetting />);
  expect(view.container.textContent).toContain("还没有主 Bot，请选择一个");
  const select = view.container.querySelector("select") as HTMLSelectElement;
  await interact(() => {
    select.value = "bot-1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await interact(() => view.container.querySelector("button")?.click());
  const call = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
  expect(call?.[0]).toBe("/api/v1/workspace/primary-bot");
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ botId: "bot-1", expectedRevision: 1 });
  expect(view.container.textContent).toContain("已保存主 Bot");
  expect(view.container.querySelector("button")?.disabled).toBe(true);
  // The workspace behind the dialog re-reads, so the sidebar crown moves.
  expect(changed).toHaveBeenCalledOnce();
  window.removeEventListener(primaryBotChangedEvent, changed);
  await view.unmount();
});
it.each([409, 404])(
  "shows a %i refusal and reloads instead of claiming success",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PUT"
          ? Response.json({ error: "refused" }, { status })
          : Response.json(snapshot),
      ),
    );
    const view = await renderComponent(<PrimaryBotSetting />);
    const select = view.container.querySelector("select") as HTMLSelectElement;
    await interact(() => {
      select.value = "bot-1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await interact(() => view.container.querySelector("button")?.click());
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      status === 409 ? "已被更新" : "已被删除",
    );
    expect(view.container.textContent).not.toContain("已保存主 Bot");
    await interact(() =>
      Array.from(view.container.querySelectorAll("button"))
        .find((button) => button.textContent === "重新读取")
        ?.click(),
    );
    expect(view.container.querySelector("select")?.value).toBe("");
    await view.unmount();
  },
);
it("fails closed when the workspace lacks the C26 fields", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ bots: snapshot.bots })),
  );
  const view = await renderComponent(<PrimaryBotSetting />);
  expect(view.container.textContent).toContain("暂不支持主 Bot");
  expect(view.container.querySelector("select")).toBeNull();
  await view.unmount();
});
