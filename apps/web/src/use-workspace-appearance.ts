import { useEffect, useState } from "react";
import { applyColorScheme } from "./color-scheme";
import { type DesktopSidebarMaterialState, getOpenBotDesktopBridge } from "./desktop-runtime";
import { useWorkspacePreferences } from "./workspace-preferences";

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
    if (values.colorScheme !== "system") return;
    let query: MediaQueryList | undefined;
    try {
      query = window.matchMedia?.("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const follow = () => applyColorScheme("system");
    query?.addEventListener?.("change", follow);
    return () => query?.removeEventListener?.("change", follow);
  }, [values.colorScheme]);
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
