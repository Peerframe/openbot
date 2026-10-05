import { getOpenBotDesktopBridge } from "./desktop-runtime";
import type { WorkspacePreferences } from "./workspace-preferences";

export type ResolvedColorScheme = "light" | "dark";

/**
 * Desktop draws its window background and sidebar material in the main process, which is still
 * fixed to light. Until it follows the Owner's choice (backlog C25) the Desktop renderer stays
 * light too, so the page never disagrees with its window.
 */
export function colorSchemeAvailable() {
  return !getOpenBotDesktopBridge();
}

export function resolveColorScheme(
  choice: WorkspacePreferences["colorScheme"],
  systemDark: boolean,
): ResolvedColorScheme {
  if (!colorSchemeAvailable()) return "light";
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
export function applyColorScheme(choice: WorkspacePreferences["colorScheme"]) {
  const resolved = resolveColorScheme(choice, systemPrefersDark());
  document.documentElement.dataset.colorScheme = resolved;
  return resolved;
}
