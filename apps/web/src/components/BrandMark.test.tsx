// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderComponent } from "../test/render-component";
import { BrandMark, pluginMark, providerMark } from "./BrandMark";

it("matches known plugin services by name or endpoint host, and nothing else", () => {
  expect(pluginMark({ name: "Gmail" })).toBeDefined();
  expect(pluginMark({ name: "Google Drive" })).not.toBe(pluginMark({ name: "Gmail" }));
  expect(pluginMark({ name: "Team mail", endpoint: "https://gmail.googleapis.com/mcp" })).toBe(
    pluginMark({ name: "Gmail" }),
  );
  expect(pluginMark({ name: "GitHub" })?.mono).toBe(true);
  expect(pluginMark({ name: "Notebook", endpoint: "not a url" })).toBeUndefined();
  expect(pluginMark({ name: "Xylophone" })).toBeUndefined();
  expect(providerMark("deepseek")).toBeDefined();
  expect(providerMark("custom")).toBeUndefined();
});

it("draws a logo, a text-coloured mask, or the first letter", async () => {
  const view = await renderComponent(
    <>
      <BrandMark mark={pluginMark({ name: "Gmail" })} label="Gmail" />
      <BrandMark mark={pluginMark({ name: "GitHub" })} label="GitHub" />
      <BrandMark mark={undefined} label="notebook" />
    </>,
  );
  try {
    const marks = view.container.querySelectorAll(".brand-mark");
    expect(marks[0]?.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/u);
    expect(marks[1]?.classList).toContain("is-mono");
    expect(marks[2]?.textContent).toBe("N");
    for (const mark of marks) expect(mark.getAttribute("aria-hidden")).toBe("true");
  } finally {
    await view.unmount();
  }
});
