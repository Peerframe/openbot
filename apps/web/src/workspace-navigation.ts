import { useCallback, useState } from "react";
import type { ProfileTab } from "./components/EmployeeProfileView";

export type WorkspaceLocation =
  | Readonly<{ kind: "home" }>
  | Readonly<{ kind: "channel"; id: string }>
  | Readonly<{ kind: "employee"; id: string; tab: ProfileTab }>
  | Readonly<{ kind: "automations" | "skills" | "work" }>;
export interface NavigationHistory {
  entries: readonly WorkspaceLocation[];
  index: number;
}
export const initialNavigation: NavigationHistory = { entries: [{ kind: "home" }], index: 0 };
function sameLocation(left: WorkspaceLocation | undefined, right: WorkspaceLocation) {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function pushLocation(
  history: NavigationHistory,
  next: WorkspaceLocation,
): NavigationHistory {
  if (sameLocation(history.entries[history.index], next)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), next].slice(-50);
  return { entries, index: entries.length - 1 };
}
export function moveLocation(history: NavigationHistory, delta: -1 | 1): NavigationHistory {
  const index = Math.max(0, Math.min(history.entries.length - 1, history.index + delta));
  return index === history.index ? history : { ...history, index };
}
export function useWorkspaceNavigation() {
  const [history, setHistory] = useState(initialNavigation);
  const navigate = useCallback(
    (next: WorkspaceLocation) => setHistory((current) => pushLocation(current, next)),
    [],
  );
  const replace = useCallback(
    (next: WorkspaceLocation) =>
      setHistory((current) => {
        if (sameLocation(current.entries[current.index], next)) return current;
        const entries = [...current.entries];
        entries[current.index] = next;
        return { ...current, entries };
      }),
    [],
  );
  const back = useCallback(() => setHistory((current) => moveLocation(current, -1)), []);
  const forward = useCallback(() => setHistory((current) => moveLocation(current, 1)), []);
  return {
    location: history.entries[history.index] ?? { kind: "home" as const },
    navigate,
    replace,
    back,
    forward,
    canGoBack: history.index > 0,
    canGoForward: history.index < history.entries.length - 1,
  };
}
