import { useEffect, useState } from "react";
import { getModelServices, listNodeIdentities } from "./api";
import type { DesktopSettingsSection } from "./components/DesktopSettingsScreen";
import { listAutomations } from "./destination-api";
import { listPlugins } from "./plugin-api";

type Counts = Partial<Record<DesktopSettingsSection, number>>;

/**
 * Settings navigation badges (SettingsNav artboard), read once each time settings opens.
 * A failed read only drops that badge; the sections load and report their own errors.
 */
export function useSettingsCounts(open: boolean): Counts {
  const [counts, setCounts] = useState<Counts>({});
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const settle = <T>(read: () => Promise<T>) => Promise.resolve().then(read);
    void Promise.allSettled([
      settle(() => getModelServices(controller.signal)),
      settle(() => listAutomations(controller.signal)),
      settle(() => listNodeIdentities(controller.signal)),
      settle(() => listPlugins(controller.signal)),
    ]).then(([models, routines, hosts, plugins]) => {
      if (controller.signal.aborted) return;
      setCounts({
        ...(models.status === "fulfilled" ? { model: models.value.connections.length } : {}),
        ...(routines.status === "fulfilled" ? { routines: routines.value.length } : {}),
        ...(hosts.status === "fulfilled"
          ? { hosts: hosts.value.filter((host) => host.status === "active").length }
          : {}),
        ...(plugins.status === "fulfilled" ? { plugins: plugins.value.plugins.length } : {}),
      });
    });
    return () => controller.abort();
  }, [open]);
  return counts;
}
