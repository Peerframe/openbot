import { getOpenBotDesktopBridge } from "./desktop-runtime";
import type { WorkspacePreferences } from "./workspace-preferences";

export type ColorSchemeChoice = WorkspacePreferences["colorScheme"];
export type ResolvedColorScheme = "light" | "dark";

/**
 * On Desktop the main process owns the choice (C25): it stores it, sets the window background and
 * sidebar material, and sets Electron's `themeSource`, which drives this page's
 * `prefers-color-scheme`. The page therefore follows that media query and sends changes through
 * the bridge. A Desktop without the bridge keeps a light window, so its page stays light too.
 */
function desktop() {
  const bridge = getOpenBotDesktopBridge();
  if (!bridge) return undefined;
  return { bridge, managed: typeof bridge.setColorScheme === "function" };
}

export function colorSchemeAvailable() {
  const host = desktop();
  return !host || host.managed;
}

export function resolveColorScheme(choice: ColorSchemeChoice, systemDark: boolean) {
  const host = desktop();
  if (host) return (host.managed && systemDark ? "dark" : "light") as ResolvedColorScheme;
  if (choice === "system") return systemDark ? "dark" : "light";
  return choice;
}

export function systemPrefersDark() {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  } catch {
    return false;
  }
}

/** Sets `data-color-scheme` on the root; tokens.css switches the whole palette from it. */
export function applyColorScheme(choice: ColorSchemeChoice) {
  const resolved = resolveColorScheme(choice, systemPrefersDark());
  document.documentElement.dataset.colorScheme = resolved;
  return resolved;
}

/** Whether the page must track `prefers-color-scheme` for this choice. */
export function followsMediaQuery(choice: ColorSchemeChoice) {
  return choice === "system" || desktop()?.managed === true;
}

/** Desktop's stored choice, so the settings row shows what the window actually uses. */
export async function readDesktopColorScheme(): Promise<ColorSchemeChoice | undefined> {
  const host = desktop();
  if (!host?.managed || !host.bridge.getColorScheme) return undefined;
  try {
    return (await host.bridge.getColorScheme()).scheme;
  } catch {
    return undefined;
  }
}

/**
 * Sends the Owner's choice to Desktop. Call it from the change handler itself: the bridge only
 * accepts a change during a user gesture.
 */
export function sendDesktopColorScheme(choice: ColorSchemeChoice) {
  const host = desktop();
  if (!host?.managed) return;
  void host.bridge.setColorScheme?.(choice).catch(() => undefined);
}

export function onDesktopColorSchemeChanged(listener: (choice: ColorSchemeChoice) => void) {
  return desktop()?.bridge.onColorSchemeChanged?.((state) => listener(state.scheme));
}
