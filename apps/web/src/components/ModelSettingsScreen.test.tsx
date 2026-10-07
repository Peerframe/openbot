// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { ModelSettingsScreen } from "./ModelSettingsScreen";

afterEach(() => vi.unstubAllGlobals());
it("uses connections and C7 defaults during onboarding, and allows deferral", async () => {
  const fetch = vi.fn(async (url: string) =>
    url === "/api/v1/model-services"
      ? Response.json({ presets: [], connections: [], customBaseUrls: [] })
      : url === "/api/v1/settings/transcription"
        ? Response.json({ revision: 1, connectionId: null })
        : Response.json({
            revision: 1,
            timezone: "UTC",
            defaultModel: null,
            updatedAt: "2026-10-05T00:00:00Z",
          }),
  );
  vi.stubGlobal("fetch", fetch);
  const done = vi.fn();
  const view = await renderComponent(<ModelSettingsScreen onboarding onDone={done} />);
  expect(view.container.textContent).toContain("默认模型");
  expect(fetch.mock.calls.map(([url]) => url)).not.toContain("/api/v1/settings/model");
  await interact(() =>
    Array.from(view.container.querySelectorAll("button"))
      .find((b) => b.textContent === "稍后再设置")
      ?.click(),
  );
  expect(done).toHaveBeenCalledOnce();
  await view.unmount();
});

async function chooseProvider(container: HTMLElement, id: string) {
  const select = container.querySelector<HTMLSelectElement>(".ob-provider-select select");
  if (!select) throw new Error("Missing provider list");
  await interact(() => {
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
