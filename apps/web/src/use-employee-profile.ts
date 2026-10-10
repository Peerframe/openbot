// Hook that reads one Bot's employee profile, re-reading on events and reconnects, cancellably.
import type { EmployeeProfile } from "@openbot/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { getEmployeeProfile } from "./api";

type ProfileState = {
  botId: string | undefined;
  profile: EmployeeProfile | undefined;
  loading: boolean;
  error: string | undefined;
};

function emptyProfile(botId: string | undefined): ProfileState {
  return { botId, profile: undefined, loading: botId !== undefined, error: undefined };
}

/** Selection, events, retries and reconnects share one cancellable read lifetime. */
export function useEmployeeProfile(botId: string | undefined) {
  const [state, setState] = useState(() => emptyProfile(botId));
  const selected = useRef<string | undefined>(undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  const refresh = useCallback(async (expectedId = selected.current) => {
    if (expectedId === undefined || expectedId !== selected.current) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setState((current) => ({ ...current, loading: true, error: undefined }));
    // Abort is advisory: transports can still resolve after cancellation or navigation.
    const isCurrent = () => pending.current === controller && !controller.signal.aborted;
    try {
      const profile = await getEmployeeProfile(expectedId, controller.signal);
      if (isCurrent()) setState({ botId: expectedId, profile, loading: false, error: undefined });
    } catch (cause) {
      if (isCurrent()) {
        setState((current) => ({
          ...current,
          loading: false,
          error: cause instanceof Error ? cause.message : "无法读取员工档案。",
        }));
      }
    } finally {
      if (pending.current === controller) pending.current = undefined;
    }
  }, []);

  useEffect(() => {
    selected.current = botId;
    setState(emptyProfile(botId));
    void refresh(botId);
    return () => {
      selected.current = undefined;
      pending.current?.abort();
      pending.current = undefined;
    };
  }, [botId, refresh]);

  // Do not expose another employee's profile during the render before effect cleanup.
  return { ...(state.botId === botId ? state : emptyProfile(botId)), refresh };
}
