// @vitest-environment jsdom
import { type DOMWindow, JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interact, renderComponent } from "./test/render-component";

let preferences: typeof import("./workspace-preferences");
let storageWindow: DOMWindow;
beforeEach(async () => {
  vi.resetModules();
  // Use a browser Storage instance even when Node exposes its own global web storage.
  storageWindow = new JSDOM("", { url: "https://openbot.test" }).window;
  vi.stubGlobal("localStorage", storageWindow.localStorage);
  vi.stubGlobal("sessionStorage", storageWindow.sessionStorage);
  window.localStorage.clear();
  preferences = await import("./workspace-preferences");
});
afterEach(() => {
  storageWindow.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function PreferenceProbe({ label = "preferences" }: { label?: string }) {
  const value = preferences.useWorkspacePreferences();
  return <output aria-label={label}>{JSON.stringify(value)}</output>;
}
function read(container: HTMLElement, label = "preferences") {
  return JSON.parse(container.querySelector(`[aria-label="${label}"]`)?.textContent ?? "null") as {
    values: import("./workspace-preferences").WorkspacePreferences;
    saved: boolean;
  };
}

describe("Workspace preference storage", () => {
  it.each([null, "", "{broken", "null", "false", '"compact"', "[]", " ".repeat(2049)])(
    "rejects malformed or oversized records (%s)",
    (raw) => {
      expect(preferences.parsePreferences(raw)).toBe(preferences.defaultPreferences);
    },
  );

  it("keeps only supported fields and values in an immutable preference record", () => {
    const parsed = preferences.parsePreferences(
      JSON.stringify({
        sidebarTranslucent: false,
        leftPanelOpen: false,
        rightPanelOpen: false,
        density: "compact",
        fontSize: "large",
        sendShortcut: "modifier",
        reduceMotion: true,
        hour12: true,
        notifyApprovals: true,
        notifyMessages: "yes",
        apiKey: "never-store-this",
        futureSetting: 7,
      }),
    );
    expect(parsed).toEqual({
      sidebarTranslucent: false,
      leftPanelOpen: false,
      rightPanelOpen: false,
      density: "compact",
      fontSize: "large",
      sendShortcut: "modifier",
      reduceMotion: true,
      hour12: true,
      notifyApprovals: true,
      notifyMessages: false,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      preferences.parsePreferences(
        '{"leftPanelOpen":"false","rightPanelOpen":"false","fontSize":"huge","density":5,"reduceMotion":1,"__proto__":{"hour12":true}}',
      ),
    ).toEqual(preferences.defaultPreferences);
  });

  it("hydrates saved values and publishes partial updates to all mounted readers", async () => {
    localStorage.setItem(
      preferences.preferencesKey,
      JSON.stringify({ density: "compact", hour12: true }),
    );
    const rendered = await renderComponent(
      <>
        <PreferenceProbe />
        <PreferenceProbe label="second" />
      </>,
    );
    try {
      expect(read(rendered.container).values.density).toBe("compact");
      await interact(() =>
        preferences.updatePreferences({ rightPanelOpen: false, fontSize: "large" }),
      );
      const expected = {
        ...preferences.defaultPreferences,
        density: "compact",
        hour12: true,
        rightPanelOpen: false,
        fontSize: "large",
      };
      expect(read(rendered.container)).toEqual({ values: expected, saved: true });
      expect(read(rendered.container, "second")).toEqual(read(rendered.container));
      expect(JSON.parse(localStorage.getItem(preferences.preferencesKey) ?? "null")).toEqual(
        expected,
      );
    } finally {
      await rendered.unmount();
    }
  });

  it("keeps in-memory preferences functional when reads or writes are disallowed", async () => {
    vi.spyOn(Object.getPrototypeOf(localStorage), "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    vi.spyOn(Object.getPrototypeOf(localStorage), "setItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    const rendered = await renderComponent(<PreferenceProbe />);
    try {
      expect(read(rendered.container)).toEqual({
        values: preferences.defaultPreferences,
        saved: false,
      });
      await interact(() =>
        preferences.updatePreferences({ sidebarTranslucent: false, sendShortcut: "modifier" }),
      );
      expect(read(rendered.container)).toEqual({
        values: {
          ...preferences.defaultPreferences,
          sidebarTranslucent: false,
          sendShortcut: "modifier",
        },
        saved: false,
      });
    } finally {
      await rendered.unmount();
    }
  });

  it("reports a failed save without discarding the last persisted record, and recovers", async () => {
    const persisted = JSON.stringify({ ...preferences.defaultPreferences, hour12: true });
    localStorage.setItem(preferences.preferencesKey, persisted);
    const rendered = await renderComponent(<PreferenceProbe />);
    const setItem = vi
      .spyOn(Object.getPrototypeOf(localStorage), "setItem")
      .mockImplementation(() => {
        throw new DOMException("Full", "QuotaExceededError");
      });
    try {
      await interact(() => preferences.updatePreferences({ density: "compact" }));
      expect(read(rendered.container).saved).toBe(false);
      expect(read(rendered.container).values.density).toBe("compact");
      expect(localStorage.getItem(preferences.preferencesKey)).toBe(persisted);
      setItem.mockRestore();
      await interact(() => preferences.updatePreferences({ fontSize: "large" }));
      expect(read(rendered.container).saved).toBe(true);
      expect(JSON.parse(localStorage.getItem(preferences.preferencesKey) ?? "null")).toMatchObject({
        density: "compact",
        fontSize: "large",
        hour12: true,
      });
    } finally {
      await rendered.unmount();
    }
  });

  it("synchronizes another local window's changes and restores defaults after clear", async () => {
    const rendered = await renderComponent(<PreferenceProbe />);
    try {
      await interact(() =>
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: preferences.preferencesKey,
            newValue: JSON.stringify({ rightPanelOpen: false }),
            storageArea: localStorage,
          }),
        ),
      );
      expect(read(rendered.container).values.rightPanelOpen).toBe(false);
      await interact(() =>
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "unrelated",
            newValue: JSON.stringify({ rightPanelOpen: true }),
            storageArea: localStorage,
          }),
        ),
      );
      expect(read(rendered.container).values.rightPanelOpen).toBe(false);
      await interact(() =>
        window.dispatchEvent(
          new StorageEvent("storage", { key: null, newValue: null, storageArea: localStorage }),
        ),
      );
      expect(read(rendered.container)).toEqual({
        values: preferences.defaultPreferences,
        saved: true,
      });
    } finally {
      await rendered.unmount();
    }
  });
  it("ignores the same key in sessionStorage", async () => {
    const rendered = await renderComponent(<PreferenceProbe />);
    try {
      await interact(() =>
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: preferences.preferencesKey,
            newValue: JSON.stringify({ rightPanelOpen: false, sidebarTranslucent: false }),
            storageArea: sessionStorage,
          }),
        ),
      );
      expect(read(rendered.container)).toEqual({
        values: preferences.defaultPreferences,
        saved: true,
      });
      expect(localStorage.getItem(preferences.preferencesKey)).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
});
