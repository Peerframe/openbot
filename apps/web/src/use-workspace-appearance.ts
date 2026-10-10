// Hook that applies density, font size, reduced motion and colour scheme to the page root, and
// tracks the Desktop sidebar material.
import { useEffect, useState } from "react";
import {
  applyColorScheme,
  followsMediaQuery,
  onDesktopColorSchemeChanged,
  readDesktopColorScheme,
} from "./color-scheme";
import { type DesktopSidebarMaterialState, getOpenBotDesktopBridge } from "./desktop-runtime";
import {
  readPreferences,
  updatePreferences,
  useWorkspacePreferences,
  type WorkspacePreferences,
} from "./workspace-preferences";

export function useWorkspaceAppearance() {
  const { values } = useWorkspacePreferences();
  const [material, setMaterial] = useState<DesktopSidebarMaterialState>({ status: "unavailable" });
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = values.density;
    root.dataset.fontSize = values.fontSize;
    root.dataset.reducedMotion = String(values.reduceMotion);
  }, [values.density, values.fontSize, values.reduceMotion]);
  useEffect(() => {
    applyColorScheme(values.colorScheme);
    if (!followsMediaQuery(values.colorScheme)) return;
    let query: MediaQueryList | undefined;
    try {
      query = window.matchMedia?.("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const follow = () => applyColorScheme(values.colorScheme);
    query?.addEventListener?.("change", follow);
    return () => query?.removeEventListener?.("change", follow);
  }, [values.colorScheme]);
  // Desktop keeps the choice in its main process; mirror it so 设置 › 主题 shows the window's
  // actual setting, including a change made from another window.
  useEffect(() => {
    let active = true;
    const mirror = (choice: WorkspacePreferences["colorScheme"]) => {
      if (active && readPreferences().colorScheme !== choice)
        updatePreferences({ colorScheme: choice });
    };
    void readDesktopColorScheme().then((choice) => choice && mirror(choice));
    const unsubscribe = onDesktopColorSchemeChanged(mirror);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    let active = true;
    const bridge = getOpenBotDesktopBridge();
    const apply = (state: DesktopSidebarMaterialState) => {
      if (!active) return;
      setMaterial(state);
      document.documentElement.dataset.sidebarMaterial = state.status;
    };
    const unsubscribe = bridge?.onSidebarMaterialChanged?.(apply);
    if (bridge?.setSidebarTranslucency) {
      void bridge
        .setSidebarTranslucency(values.sidebarTranslucent)
        .then(apply, () => apply({ status: "unavailable" }));
    } else {
      apply({ status: "unsupported" });
    }
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [values.sidebarTranslucent]);
  return material;
}
