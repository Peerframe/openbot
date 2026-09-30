import { useSyncExternalStore } from "react";

export interface WorkspacePreferences {
  sidebarTranslucent: boolean;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  density: "comfortable" | "compact";
  fontSize: "normal" | "large";
  sendShortcut: "enter" | "modifier";
  reduceMotion: boolean;
  hour12: boolean;
  /** Opt-in system notifications; presentation only, they grant and decide nothing. */
  notifyApprovals: boolean;
  notifyMessages: boolean;
}

export const defaultPreferences: Readonly<WorkspacePreferences> = Object.freeze({
  sidebarTranslucent: true,
  leftPanelOpen: true,
  rightPanelOpen: true,
  density: "comfortable",
  fontSize: "normal",
  sendShortcut: "enter",
  reduceMotion: false,
  hour12: false,
  notifyApprovals: false,
  notifyMessages: false,
});
export const preferencesKey = "openbot.workspace-preferences.v1";

export function parsePreferences(raw: string | null): Readonly<WorkspacePreferences> {
  if (!raw || raw.length > 2048) return defaultPreferences;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaultPreferences;
    const input = value as Record<string, unknown>;
    return Object.freeze({
      sidebarTranslucent:
        typeof input.sidebarTranslucent === "boolean" ? input.sidebarTranslucent : true,
      leftPanelOpen: typeof input.leftPanelOpen === "boolean" ? input.leftPanelOpen : true,
      rightPanelOpen: typeof input.rightPanelOpen === "boolean" ? input.rightPanelOpen : true,
      density: input.density === "compact" ? "compact" : "comfortable",
      fontSize: input.fontSize === "large" ? "large" : "normal",
      sendShortcut: input.sendShortcut === "modifier" ? "modifier" : "enter",
      reduceMotion: input.reduceMotion === true,
      hour12: input.hour12 === true,
      notifyApprovals: input.notifyApprovals === true,
      notifyMessages: input.notifyMessages === true,
    });
  } catch {
    return defaultPreferences;
  }
}

type Snapshot = Readonly<{ values: Readonly<WorkspacePreferences>; saved: boolean }>;
let snapshot: Snapshot | undefined;
const listeners = new Set<() => void>();
const serverSnapshot: Snapshot = { values: defaultPreferences, saved: true };

function getSnapshot(): Snapshot {
  if (!snapshot) {
    try {
      snapshot = {
        values: parsePreferences(window.localStorage.getItem(preferencesKey)),
        saved: true,
      };
    } catch {
      snapshot = { values: defaultPreferences, saved: false };
    }
  }
  return snapshot;
}

function onStorage(event: StorageEvent) {
  try {
    if (event.storageArea !== window.localStorage) return;
  } catch {
    return;
  }
  if (event.key !== preferencesKey && event.key !== null) return;
  snapshot = { values: parsePreferences(event.newValue), saved: true };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function updatePreferences(update: Partial<WorkspacePreferences>) {
  // Round-trip the allowlist so neither callers nor persisted data can retain unrelated fields.
  const values = parsePreferences(JSON.stringify({ ...getSnapshot().values, ...update }));
  let saved = true;
  try {
    window.localStorage.setItem(preferencesKey, JSON.stringify(values));
  } catch {
    saved = false;
  }
  snapshot = { values, saved };
  for (const listener of listeners) listener();
}

export function useWorkspacePreferences() {
  return useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}
