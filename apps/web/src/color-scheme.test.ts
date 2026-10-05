// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { applyColorScheme, colorSchemeAvailable, resolveColorScheme } from "./color-scheme";

afterEach(() => {
  delete (window as { openbotDesktop?: unknown }).openbotDesktop;
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.colorScheme;
});

function stubSystem(dark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: dark && query === "(prefers-color-scheme: dark)" })),
  );
}

it("resolves an explicit choice, or follows the system", () => {
  expect(resolveColorScheme("dark", false)).toBe("dark");
  expect(resolveColorScheme("light", true)).toBe("light");
  expect(resolveColorScheme("system", true)).toBe("dark");
  expect(resolveColorScheme("system", false)).toBe("light");
});

it("sets the root attribute that switches the palette", () => {
  stubSystem(true);
  expect(applyColorScheme("system")).toBe("dark");
  expect(document.documentElement.dataset.colorScheme).toBe("dark");
  expect(applyColorScheme("light")).toBe("light");
  expect(document.documentElement.dataset.colorScheme).toBe("light");
});

it("keeps Desktop light until its window can follow the choice (C25)", () => {
  stubSystem(true);
  const method = () => Promise.resolve();
  window.openbotDesktop = {
    getConnectionState: method,
    configureServer: method,
    getSetupPlanState: method,
    saveSetupPlan: method,
    getLocalWorkerState: method,
    setupLocalWorker: method,
    enableLocalWorker: method,
    openLocalWorkerSettings: method,
  } as unknown as typeof window.openbotDesktop;
  expect(colorSchemeAvailable()).toBe(false);
  expect(applyColorScheme("dark")).toBe("light");
  expect(document.documentElement.dataset.colorScheme).toBe("light");
});

it("follows Desktop's window once it can switch, and sends the choice through the bridge", async () => {
  stubSystem(true);
  const method = () => Promise.resolve();
  const setColorScheme = vi.fn(async (scheme: string) => ({ scheme, resolved: "dark" }));
  window.openbotDesktop = {
    getConnectionState: method,
    configureServer: method,
    getSetupPlanState: method,
    saveSetupPlan: method,
    getLocalWorkerState: method,
    setupLocalWorker: method,
    enableLocalWorker: method,
    openLocalWorkerSettings: method,
    getColorScheme: async () => ({ scheme: "dark", resolved: "dark" }),
    setColorScheme,
  } as unknown as typeof window.openbotDesktop;
  const { readDesktopColorScheme, sendDesktopColorScheme, followsMediaQuery } = await import(
    "./color-scheme"
  );
  expect(colorSchemeAvailable()).toBe(true);
  // The main process drives prefers-color-scheme, so even "light" follows the media query here.
  expect(applyColorScheme("light")).toBe("dark");
  expect(followsMediaQuery("light")).toBe(true);
  await expect(readDesktopColorScheme()).resolves.toBe("dark");
  sendDesktopColorScheme("system");
  expect(setColorScheme).toHaveBeenCalledWith("system");
});
