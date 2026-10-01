import { RestrictedJsonFile } from "./restricted-json-file.js";
import type { DesktopPlatformPreferences, DesktopPlatformState } from "./runtime-contract.js";

const FORMAT = "openbot.desktop-platform/v1";
export const DEFAULT_PLATFORM_PREFERENCES: Readonly<DesktopPlatformPreferences> = Object.freeze({
  launchAtLogin: false,
  runInBackground: false,
  globalShortcut: "",
  showDockBadge: true,
  automaticUpdates: false,
});

export function parsePlatformPreferences(value: unknown): DesktopPlatformPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid Desktop preferences.");
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !==
    "automaticUpdates,globalShortcut,launchAtLogin,runInBackground,showDockBadge"
  )
    throw new TypeError("Unknown Desktop preferences.");
  for (const key of ["launchAtLogin", "runInBackground", "showDockBadge", "automaticUpdates"]) {
    if (typeof candidate[key] !== "boolean")
      throw new TypeError("Invalid Desktop preference flag.");
  }
  const shortcut = candidate.globalShortcut;
  if (typeof shortcut !== "string" || shortcut.length > 96)
    throw new TypeError("Invalid Desktop shortcut.");
  if (shortcut !== "") {
    const tokens = shortcut.split("+");
    const key = tokens.pop();
    if (
      !key ||
      !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/u.test(key) ||
      tokens.length < 1 ||
      tokens.length > 4 ||
      new Set(tokens).size !== tokens.length ||
      !tokens.some((part) => ["CommandOrControl", "Command", "Control", "Super"].includes(part)) ||
      tokens.some(
        (part) =>
          !["CommandOrControl", "Command", "Control", "Alt", "Option", "Shift", "Super"].includes(
            part,
          ),
      )
    )
      throw new TypeError("Invalid Desktop shortcut.");
  }
  return Object.freeze({
    launchAtLogin: candidate.launchAtLogin as boolean,
    runInBackground: candidate.runInBackground as boolean,
    globalShortcut: shortcut,
    showDockBadge: candidate.showDockBadge as boolean,
    automaticUpdates: candidate.automaticUpdates as boolean,
  });
}

export interface PlatformPreferenceStore {
  load(): Promise<DesktopPlatformPreferences | undefined>;
  save(value: DesktopPlatformPreferences): Promise<void>;
}
export class FilePlatformPreferenceStore implements PlatformPreferenceStore {
  readonly file: RestrictedJsonFile<{
    format: typeof FORMAT;
    preferences: DesktopPlatformPreferences;
  }>;
  constructor(path: string) {
    this.file = new RestrictedJsonFile(path, {
      label: "Desktop platform preferences",
      maximumBytes: 4096,
      parse: (text) => {
        const value: unknown = JSON.parse(text);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).sort().join(",") !== "format,preferences" ||
          (value as { format?: unknown }).format !== FORMAT
        )
          throw new TypeError("Invalid Desktop preference file.");
        return {
          format: FORMAT,
          preferences: parsePlatformPreferences((value as { preferences?: unknown }).preferences),
        };
      },
    });
  }
  async load() {
    return (await this.file.load())?.preferences;
  }
  async save(preferences: DesktopPlatformPreferences) {
    await this.file.save({ format: FORMAT, preferences: parsePlatformPreferences(preferences) });
  }
}
export interface PlatformPreferencePorts {
  capabilities: DesktopPlatformState["capabilities"];
  currentLaunchAtLogin(): boolean;
  setLaunchAtLogin(value: boolean): void;
  setTray(value: boolean): void;
  registerShortcut(value: string): boolean;
  unregisterShortcut(value: string): void;
  setBadge(count: number): boolean;
  changed(value: DesktopPlatformPreferences): void;
}
export class DesktopPlatformController {
  private preferences: DesktopPlatformPreferences;
  private status: DesktopPlatformState["status"] = "ready";
  private busy = false;
  private unread = 0;
  constructor(
    private readonly store: PlatformPreferenceStore,
    private readonly ports: PlatformPreferencePorts,
  ) {
    this.preferences = {
      ...DEFAULT_PLATFORM_PREFERENCES,
      launchAtLogin: ports.capabilities.launchAtLogin && ports.currentLaunchAtLogin(),
    };
  }
  state(code?: DesktopPlatformState["code"]): DesktopPlatformState {
    return {
      status: this.status,
      preferences: Object.freeze({ ...this.preferences }),
      capabilities: this.ports.capabilities,
      ...(code ? { code } : {}),
    };
  }
  async initialize() {
    try {
      const stored = await this.store.load();
      if (stored) return await this.update(stored, false);
    } catch {
      this.status = "invalid";
    }
    return this.state();
  }
  async update(value: unknown, persist = true): Promise<DesktopPlatformState> {
    if (this.busy || this.status === "invalid") return this.state();
    let next: DesktopPlatformPreferences;
    try {
      next = parsePlatformPreferences(value);
    } catch {
      return { ...this.state(), status: "invalid" };
    }
    if (
      (next.launchAtLogin && !this.ports.capabilities.launchAtLogin) ||
      (next.runInBackground && !this.ports.capabilities.tray) ||
      (next.automaticUpdates && !this.ports.capabilities.updates)
    )
      return { ...this.state("unsupported"), status: "failed" };
    const previous = this.preferences;
    const newShortcut =
      next.globalShortcut !== previous.globalShortcut && next.globalShortcut !== "";
    this.busy = true;
    let registered = false;
    let nativeChanged = false;
    let committed = false;
    let saving = false;
    let code: DesktopPlatformState["code"] = "native_unavailable";
    try {
      if (newShortcut) {
        registered = this.ports.registerShortcut(next.globalShortcut);
        if (!registered) return { ...this.state("shortcut_unavailable"), status: "failed" };
      }
      nativeChanged = true;
      if (this.ports.capabilities.launchAtLogin && next.launchAtLogin !== previous.launchAtLogin)
        this.ports.setLaunchAtLogin(next.launchAtLogin);
      this.ports.setTray(next.runInBackground);
      this.ports.setBadge(next.showDockBadge ? this.unread : 0);
      if (persist) {
        code = "storage_unavailable";
        saving = true;
        await this.store.save(next);
      }
      this.preferences = next;
      committed = true;
      if (previous.globalShortcut && previous.globalShortcut !== next.globalShortcut)
        this.ports.unregisterShortcut(previous.globalShortcut);
      this.status = "ready";
      this.ports.changed(next);
      return this.state();
    } catch {
      // Persistence is the commit point. A later native failure must retain the committed DTO.
      if (committed) {
        this.status = "failed";
        return this.state("native_unavailable");
      }
      try {
        if (registered) this.ports.unregisterShortcut(next.globalShortcut);
        if (nativeChanged) {
          if (this.ports.capabilities.launchAtLogin)
            this.ports.setLaunchAtLogin(previous.launchAtLogin);
          this.ports.setTray(previous.runInBackground);
          this.ports.setBadge(previous.showDockBadge ? this.unread : 0);
        }
        // An atomic rename may have succeeded before its verification failed. Restore the old DTO.
        if (saving) await this.store.save(previous);
      } catch {
        this.status = "failed";
        return this.state("rollback_unavailable");
      }
      return { ...this.state(code), status: "failed" };
    } finally {
      this.busy = false;
    }
  }
  badge(value: unknown): boolean {
    if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > 99999)
      return false;
    this.unread = Math.min(99, value);
    return (
      this.ports.capabilities.badge &&
      this.ports.setBadge(this.preferences.showDockBadge ? this.unread : 0)
    );
  }
  close() {
    if (this.preferences.globalShortcut)
      this.ports.unregisterShortcut(this.preferences.globalShortcut);
    this.ports.setTray(false);
    this.ports.setBadge(0);
  }
}
