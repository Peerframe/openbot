// Per-device sidebar arrangement in localStorage: pins, groups, folding, hidden rows, mute and
// unread marks, plus the sort and search used by the sidebar. Never a Server write.
import { useSyncExternalStore } from "react";

/**
 * Per-device sidebar arrangement: pins, groups, hidden rows and manual unread marks.
 *
 * This is presentation state only. It never renames, deletes or authorizes anything: the Server
 * remains the source of truth for channels and Bots, and unknown keys are simply ignored when the
 * referenced conversation no longer exists.
 */
export type SidebarItemKey = `channel:${string}` | `bot:${string}`;

export interface SidebarGroup {
  id: string;
  name: string;
}

export interface SidebarOrganization {
  pinned: readonly SidebarItemKey[];
  hidden: readonly SidebarItemKey[];
  unread: readonly SidebarItemKey[];
  groups: readonly SidebarGroup[];
  membership: Readonly<Record<SidebarItemKey, string>>;
  /** Group ids whose rows are folded away outside search. */
  collapsed: readonly string[];
  /** Conversations whose opt-in system notifications are silenced on this device. */
  muted: readonly SidebarItemKey[];
}

export const sidebarOrganizationKey = "openbot.sidebar-organization.v1";
export const maxGroupNameLength = 40;
const maxGroups = 50;
const maxKeys = 500;
const maxRawLength = 64 * 1024;

export const emptyOrganization: Readonly<SidebarOrganization> = Object.freeze({
  pinned: Object.freeze([]),
  hidden: Object.freeze([]),
  unread: Object.freeze([]),
  groups: Object.freeze([]),
  membership: Object.freeze({}),
  collapsed: Object.freeze([]),
  muted: Object.freeze([]),
});

function isItemKey(value: unknown): value is SidebarItemKey {
  return typeof value === "string" && value.length <= 200 && /^(channel|bot):[^\s]+$/.test(value);
}

function keyList(value: unknown): SidebarItemKey[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(isItemKey))).slice(0, maxKeys);
}

export function normalizeGroupName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, maxGroupNameLength);
}

export function parseOrganization(raw: string | null): Readonly<SidebarOrganization> {
  if (!raw || raw.length > maxRawLength) return emptyOrganization;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyOrganization;
    const input = value as Record<string, unknown>;
    const groups: SidebarGroup[] = [];
    if (Array.isArray(input.groups)) {
      for (const group of input.groups) {
        if (!group || typeof group !== "object") continue;
        const { id, name } = group as Record<string, unknown>;
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
        if (typeof name !== "string") continue;
        const normalized = normalizeGroupName(name);
        if (!normalized || groups.some((existing) => existing.id === id)) continue;
        groups.push({ id, name: normalized });
        if (groups.length === maxGroups) break;
      }
    }
    const groupIds = new Set(groups.map((group) => group.id));
    const membership: Record<SidebarItemKey, string> = {};
    if (input.membership && typeof input.membership === "object") {
      let count = 0;
      for (const [key, groupId] of Object.entries(input.membership)) {
        if (!isItemKey(key) || typeof groupId !== "string" || !groupIds.has(groupId)) continue;
        membership[key] = groupId;
        if (++count === maxKeys) break;
      }
    }
    const collapsed = Array.isArray(input.collapsed)
      ? Array.from(
          new Set(
            input.collapsed.filter(
              (id): id is string => typeof id === "string" && groupIds.has(id),
            ),
          ),
        )
      : [];
    return Object.freeze({
      pinned: keyList(input.pinned),
      hidden: keyList(input.hidden),
      unread: keyList(input.unread),
      groups,
      membership,
      collapsed,
      muted: keyList(input.muted),
    });
  } catch {
    return emptyOrganization;
  }
}

type Snapshot = Readonly<{ values: Readonly<SidebarOrganization>; saved: boolean }>;
let snapshot: Snapshot | undefined;
const listeners = new Set<() => void>();
const serverSnapshot: Snapshot = { values: emptyOrganization, saved: true };

function getSnapshot(): Snapshot {
  if (!snapshot) {
    try {
      snapshot = {
        values: parseOrganization(window.localStorage.getItem(sidebarOrganizationKey)),
        saved: true,
      };
    } catch {
      snapshot = { values: emptyOrganization, saved: false };
    }
  }
  return snapshot;
}

function onStorage(event: StorageEvent) {
  try {
    if (event.storageArea !== window.localStorage) return;
  } catch {
    return;
  }
  if (event.key !== sidebarOrganizationKey && event.key !== null) return;
  snapshot = { values: parseOrganization(event.newValue), saved: true };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function commit(next: SidebarOrganization) {
  // Round-trip through the parser so every write keeps the same bounds as a read.
  const values = parseOrganization(JSON.stringify(next));
  let saved = true;
  try {
    window.localStorage.setItem(sidebarOrganizationKey, JSON.stringify(values));
  } catch {
    saved = false;
  }
  snapshot = { values, saved };
  for (const listener of listeners) listener();
}

function toggle(list: readonly SidebarItemKey[], key: SidebarItemKey, on: boolean) {
  const rest = list.filter((item) => item !== key);
  return on ? [key, ...rest] : rest;
}

export const sidebarOrganization = {
  /** Current arrangement for non-React callers (for example the notification filter). */
  snapshot(): Readonly<SidebarOrganization> {
    return getSnapshot().values;
  },
  setPinned(key: SidebarItemKey, pinned: boolean) {
    const current = getSnapshot().values;
    commit({ ...current, pinned: toggle(current.pinned, key, pinned) });
  },
  setHidden(key: SidebarItemKey, hidden: boolean) {
    const current = getSnapshot().values;
    commit({ ...current, hidden: toggle(current.hidden, key, hidden) });
  },
  setUnread(key: SidebarItemKey, unread: boolean) {
    const current = getSnapshot().values;
    if (current.unread.includes(key) === unread) return;
    commit({ ...current, unread: toggle(current.unread, key, unread) });
  },
  /** Moves an item into a new group; returns false when the name is empty or limits are reached. */
  moveToNewGroup(key: SidebarItemKey, name: string): boolean {
    const current = getSnapshot().values;
    const normalized = normalizeGroupName(name);
    if (!normalized || current.groups.length >= maxGroups) return false;
    const existing = current.groups.find((group) => group.name === normalized);
    const group = existing ?? { id: newGroupId(current.groups), name: normalized };
    commit({
      ...current,
      groups: existing ? current.groups : [...current.groups, group],
      membership: { ...current.membership, [key]: group.id },
    });
    return true;
  },
  moveToGroup(key: SidebarItemKey, groupId: string | undefined) {
    const current = getSnapshot().values;
    const membership = { ...current.membership };
    if (groupId === undefined) delete membership[key];
    else if (current.groups.some((group) => group.id === groupId)) membership[key] = groupId;
    else return;
    commit({ ...current, membership });
  },
  renameGroup(groupId: string, name: string): boolean {
    const current = getSnapshot().values;
    const normalized = normalizeGroupName(name);
    if (!normalized) return false;
    commit({
      ...current,
      groups: current.groups.map((group) =>
        group.id === groupId ? { ...group, name: normalized } : group,
      ),
    });
    return true;
  },
  setMuted(key: SidebarItemKey, muted: boolean) {
    const current = getSnapshot().values;
    commit({ ...current, muted: toggle(current.muted, key, muted) });
  },
  setCollapsed(groupId: string, collapsed: boolean) {
    const current = getSnapshot().values;
    const rest = current.collapsed.filter((id) => id !== groupId);
    commit({ ...current, collapsed: collapsed ? [...rest, groupId] : rest });
  },
  /** Drops every arrangement entry for an item the Server deleted, freeing its bounded slots. */
  forget(key: SidebarItemKey) {
    const current = getSnapshot().values;
    const membership = { ...current.membership };
    delete membership[key];
    commit({
      ...current,
      pinned: toggle(current.pinned, key, false),
      hidden: toggle(current.hidden, key, false),
      unread: toggle(current.unread, key, false),
      muted: toggle(current.muted, key, false),
      membership,
    });
  },
  /** Removes the group only; its conversations fall back to "未分组" and are never deleted. */
  dissolveGroup(groupId: string) {
    const current = getSnapshot().values;
    const membership = Object.fromEntries(
      Object.entries(current.membership).filter(([, id]) => id !== groupId),
    ) as Record<SidebarItemKey, string>;
    commit({
      ...current,
      groups: current.groups.filter((group) => group.id !== groupId),
      membership,
      collapsed: current.collapsed.filter((id) => id !== groupId),
    });
  },
};

function newGroupId(groups: readonly SidebarGroup[]): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!groups.some((group) => group.id === id)) return id;
  }
  return `g${groups.length + 1}`;
}

export function useSidebarOrganization() {
  return useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}

export interface SidebarEntry<T> {
  key: SidebarItemKey;
  item: T;
  name: string;
  searchText: string;
  /** Server-reported latest activity (ISO time); orders unpinned rows newest first. */
  activityAt?: string | undefined;
}

/** Pinned rows first in pin order, then the most recent activity, then the original order. */
function sidebarOrder<T>(pinnedRank: ReadonlyMap<SidebarItemKey, number>) {
  return (left: SidebarEntry<T>, right: SidebarEntry<T>) => {
    const a = pinnedRank.get(left.key);
    const b = pinnedRank.get(right.key);
    if (a !== undefined || b !== undefined)
      return a === undefined ? 1 : b === undefined ? -1 : a - b;
    const at = (entry: SidebarEntry<T>) => (entry.activityAt ? Date.parse(entry.activityAt) : NaN);
    const x = at(left);
    const y = at(right);
    if (Number.isNaN(x) || Number.isNaN(y))
      return Number.isNaN(x) === Number.isNaN(y) ? 0 : Number.isNaN(x) ? 1 : -1;
    return y - x;
  };
}

export interface SidebarSection<T> {
  /** undefined for the ungrouped section. */
  group: SidebarGroup | undefined;
  entries: SidebarEntry<T>[];
  /** The query matched the group name, so every member is shown. */
  matchedGroup: boolean;
  /** Folded group: the heading stays, its rows are not rendered. */
  collapsed: boolean;
}

/**
 * Arranges entries into group sections, pinned first inside each section.
 * Hidden entries only appear while searching; a search that matches a group name shows the group.
 */
export function arrangeSidebar<T>(
  entries: SidebarEntry<T>[],
  organization: Readonly<SidebarOrganization>,
  query: string,
  /** Hidden rows with new activity reappear (design: 收到新消息会重新出现). */
  revealed: ReadonlySet<SidebarItemKey> = new Set(),
): SidebarSection<T>[] {
  const term = query.trim().toLocaleLowerCase();
  const hidden = new Set(organization.hidden);
  const folded = new Set(organization.collapsed ?? []);
  const pinnedRank = new Map(organization.pinned.map((key, index) => [key, index]));
  const sections: SidebarSection<T>[] = organization.groups.map((group) => ({
    group,
    entries: [],
    matchedGroup: term.length > 0 && group.name.toLocaleLowerCase().includes(term),
    collapsed: !term && folded.has(group.id),
  }));
  const ungrouped: SidebarSection<T> = {
    group: undefined,
    entries: [],
    matchedGroup: false,
    collapsed: false,
  };
  for (const entry of entries) {
    const groupId = organization.membership[entry.key];
    const section = sections.find((candidate) => candidate.group?.id === groupId) ?? ungrouped;
    const visible = term
      ? section.matchedGroup || entry.searchText.toLocaleLowerCase().includes(term)
      : !hidden.has(entry.key) || revealed.has(entry.key);
    if (visible) section.entries.push(entry);
  }
  for (const section of [...sections, ungrouped]) section.entries.sort(sidebarOrder(pinnedRank));
  return [...sections, ungrouped].filter(
    (section) =>
      section.entries.length > 0 ||
      (section.collapsed && section.group !== undefined) ||
      (section.matchedGroup && term.length > 0),
  );
}

export interface SidebarSearchResult<T> {
  /** Groups whose name matches, each with all of its conversations. */
  groups: { group: SidebarGroup; entries: SidebarEntry<T>[] }[];
  /** Conversations matching by name or tag, hidden ones included. */
  conversations: SidebarEntry<T>[];
}

/** The design's search: a 分组 section and a 对话 section, ordered like the sidebar. */
export function searchSidebar<T>(
  entries: SidebarEntry<T>[],
  organization: Readonly<SidebarOrganization>,
  query: string,
): SidebarSearchResult<T> {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return { groups: [], conversations: [] };
  const pinnedRank = new Map(organization.pinned.map((key, index) => [key, index]));
  const byPin = sidebarOrder<T>(pinnedRank);
  const groups = organization.groups
    .filter((group) => group.name.toLocaleLowerCase().includes(term))
    .map((group) => ({
      group,
      entries: entries
        .filter((entry) => organization.membership[entry.key] === group.id)
        .sort(byPin),
    }));
  const conversations = entries
    .filter((entry) => entry.searchText.toLocaleLowerCase().includes(term))
    .sort(byPin);
  return { groups, conversations };
}

/** Splits text around the first case-insensitive match so the hit can be marked. */
export function highlightMatch(text: string, query: string) {
  const term = query.trim();
  const index = term ? text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase()) : -1;
  if (index < 0) return { before: text, hit: "", after: "" };
  return {
    before: text.slice(0, index),
    hit: text.slice(index, index + term.length),
    after: text.slice(index + term.length),
  };
}
