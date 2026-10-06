import { describe, expect, it } from "vitest";
import {
  initialNavigation,
  moveLocation,
  type NavigationHistory,
  pushLocation,
} from "./workspace-navigation";

describe("workspace navigation history", () => {
  it("keeps the current entry for repeated navigation and bounds back/forward", () => {
    expect(pushLocation(initialNavigation, { kind: "home" })).toBe(initialNavigation);
    expect(moveLocation(initialNavigation, -1)).toBe(initialNavigation);
    expect(moveLocation(initialNavigation, 1)).toBe(initialNavigation);
    const channel = pushLocation(initialNavigation, { kind: "channel", id: "channel-a" });
    expect(pushLocation(channel, { kind: "channel", id: "channel-a" })).toBe(channel);
    const profile = pushLocation(channel, { kind: "work" });
    expect(profile.entries[profile.index]).toEqual({ kind: "work" });
    const back = moveLocation(profile, -1);
    expect(back.entries[back.index]).toEqual({ kind: "channel", id: "channel-a" });
    const forward = moveLocation(back, 1);
    expect(forward.entries[forward.index]).toEqual(profile.entries[profile.index]);
    expect(moveLocation(forward, 1)).toBe(forward);
    expect(initialNavigation).toEqual({ entries: [{ kind: "home" }], index: 0 });
  });

  it("discards only forward history when opening a different destination after back", () => {
    const channel = pushLocation(initialNavigation, { kind: "channel", id: "channel-a" });
    const work = pushLocation(channel, { kind: "work" });
    const profile = pushLocation(work, { kind: "new" });
    const back = moveLocation(profile, -1);
    const next = pushLocation(back, { kind: "channel", id: "channel-b" });
    expect(next).toEqual({
      entries: [
        { kind: "home" },
        { kind: "channel", id: "channel-a" },
        { kind: "work" },
        { kind: "channel", id: "channel-b" },
      ],
      index: 3,
    });
    expect(moveLocation(next, 1)).toBe(next);
    expect(profile.entries[3]).toEqual({ kind: "new" });
  });

  it("retains at most 50 locations with a reachable oldest and newest entry", () => {
    let history: NavigationHistory = initialNavigation;
    for (let index = 0; index < 65; index += 1) {
      history = pushLocation(history, { kind: "channel", id: `channel-${index}` });
    }
    expect(history.entries).toHaveLength(50);
    expect(history.index).toBe(49);
    expect(history.entries[0]).toEqual({ kind: "channel", id: "channel-15" });
    expect(history.entries[49]).toEqual({ kind: "channel", id: "channel-64" });
    for (let index = 0; index < 55; index += 1) history = moveLocation(history, -1);
    expect(history.index).toBe(0);
    expect(history.entries[history.index]).toEqual({ kind: "channel", id: "channel-15" });
  });
});
