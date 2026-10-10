// Wires Desktop menu commands and the matching Web keyboard shortcuts (new conversation, back,
// forward, settings, panel toggles) to the workspace's navigation actions.
import { useEffect, useRef } from "react";
import { type DesktopNavigationCommand, getOpenBotDesktopBridge } from "./desktop-runtime";
import { updatePreferences, useWorkspacePreferences } from "./workspace-preferences";

interface NavigationActions {
  active: boolean;
  settingsAvailable: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack(): void;
  onForward(): void;
  onNewConversation(): void;
  onSettings?: (() => void) | undefined;
}

export function useDesktopNavigation(actions: NavigationActions) {
  const { values } = useWorkspacePreferences();
  const current = useRef({ actions, values });
  current.current = { actions, values };
  useEffect(() => {
    const bridge = getOpenBotDesktopBridge();
    const handle = (command: DesktopNavigationCommand) => {
      const { actions: next, values: preferences } = current.current;
      if (command === "open-settings") {
        if (next.settingsAvailable) next.onSettings?.();
        return;
      }
      if (!next.active) return;
      switch (command) {
        case "new-conversation":
          next.onNewConversation();
          break;
        case "go-back":
          if (next.canGoBack) next.onBack();
          break;
        case "go-forward":
          if (next.canGoForward) next.onForward();
          break;
        case "toggle-sidebar":
          updatePreferences({ leftPanelOpen: !preferences.leftPanelOpen });
          break;
        case "toggle-details":
          updatePreferences({ rightPanelOpen: !preferences.rightPanelOpen });
          break;
      }
    };
    const unsubscribe = bridge?.onNavigationCommand?.(handle);
    // Native menu accelerators own desktop shortcuts; the Web surface gets the same commands.
    const keydown = (event: KeyboardEvent) => {
      if (
        bridge?.onNavigationCommand ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        (!event.metaKey && !event.ctrlKey)
      )
        return;
      const key = event.key.toLowerCase();
      const command: DesktopNavigationCommand | undefined =
        key === "n" && !event.shiftKey
          ? "new-conversation"
          : key === "," && !event.shiftKey
            ? "open-settings"
            : key === "["
              ? "go-back"
              : key === "]"
                ? "go-forward"
                : key === "b"
                  ? event.shiftKey
                    ? "toggle-details"
                    : "toggle-sidebar"
                  : undefined;
      if (!command) return;
      event.preventDefault();
      handle(command);
    };
    window.addEventListener("keydown", keydown);
    return () => {
      unsubscribe?.();
      window.removeEventListener("keydown", keydown);
    };
  }, []);
  useEffect(() => {
    const bridge = getOpenBotDesktopBridge();
    void bridge
      ?.updateNavigationMenuState?.({
        workspaceReady: actions.active,
        settingsAvailable: actions.settingsAvailable,
        canGoBack: actions.active && actions.canGoBack,
        canGoForward: actions.active && actions.canGoForward,
      })
      .catch(() => {});
    return () => {
      void bridge
        ?.updateNavigationMenuState?.({
          workspaceReady: false,
          settingsAvailable: false,
          canGoBack: false,
          canGoForward: false,
        })
        .catch(() => {});
    };
  }, [actions.active, actions.settingsAvailable, actions.canGoBack, actions.canGoForward]);
}
