import type { EmployeeProfile } from "@openbot/domain";
import { useEffect, useState } from "react";
import { getEmployeeProfile } from "./api";

/**
 * Reads the profiles of several Bots with at most four requests in flight, so a large workspace
 * cannot flood the authenticated Server. Bump `revision` to re-read after a change.
 */
export function useEmployeeProfiles(botIds: readonly string[], revision = 0) {
  const [profiles, setProfiles] = useState<ReadonlyMap<string, EmployeeProfile>>(new Map());
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const requestKey = JSON.stringify({ ids: [...botIds].sort(), revision });

  useEffect(() => {
    const controller = new AbortController();
    const { ids } = JSON.parse(requestKey) as { ids: string[] };
    const next = new Map<string, EmployeeProfile>();
    const failed: string[] = [];
    let cursor = 0;
    setLoading(true);
    setProfiles(new Map());
    setFailedIds([]);
    const readers = Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length && !controller.signal.aborted) {
        const id = ids[cursor++];
        if (id === undefined) break;
        try {
          next.set(
            id,
            await getEmployeeProfile(
              id,
              AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
            ),
          );
        } catch {
          failed.push(id);
        }
      }
    });
    void Promise.all(readers).then(() => {
      if (controller.signal.aborted) return;
      setProfiles(next);
      setFailedIds(failed);
      setLoading(false);
    });
    return () => controller.abort();
  }, [requestKey]);

  return { profiles, failedIds, loading };
}
