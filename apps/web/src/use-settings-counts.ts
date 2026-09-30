import { useEffect, useState } from "react";
import { getModelServices } from "./api";
import type { DesktopSettingsSection } from "./components/DesktopSettingsScreen";
import { listAutomations } from "./destination-api";

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
    void Promise.allSettled([
      getModelServices(controller.signal),
      listAutomations(controller.signal),
    ]).then(([models, routines]) => {
      if (controller.signal.aborted) return;
      setCounts({
        ...(models.status === "fulfilled" ? { model: models.value.connections.length } : {}),
        ...(routines.status === "fulfilled" ? { routines: routines.value.length } : {}),
      });
    });
    return () => controller.abort();
  }, [open]);
  return counts;
}
