import type { DesktopPlatformController } from "./platform-preferences.js";
import type { DesktopColorScheme, DesktopColorSchemeState } from "./runtime-contract.js";

export function parseColorScheme(value: unknown): DesktopColorScheme {
  if (value !== "system" && value !== "light" && value !== "dark")
    throw new TypeError("Invalid Desktop color scheme.");
  return value;
}

export function colorSchemeBackground(state: DesktopColorSchemeState): string {
  return state.resolved === "dark" ? "#141414" : "#ffffff";
}

export interface NativeThemePort {
  themeSource: DesktopColorScheme;
  readonly shouldUseDarkColors: boolean;
  on(event: "updated", listener: () => void): unknown;
  removeListener(event: "updated", listener: () => void): unknown;
}

/** Preferences are committed by the existing store; nativeTheme only resolves presentation. */
export class DesktopColorSchemeController {
  private previous: DesktopColorSchemeState | undefined;
  private readonly updated = () => this.publish();
  constructor(
    private readonly theme: NativeThemePort,
    private readonly platform: DesktopPlatformController,
    private readonly changed: (state: DesktopColorSchemeState) => void,
  ) {
    theme.on("updated", this.updated);
  }
  state(): DesktopColorSchemeState {
    return Object.freeze({
      scheme: this.platform.state().preferences.colorScheme ?? "system",
      resolved: this.theme.shouldUseDarkColors ? "dark" : "light",
    });
  }
  apply(): DesktopColorSchemeState {
    const scheme = this.platform.state().preferences.colorScheme ?? "system";
    if (this.theme.themeSource !== scheme) this.theme.themeSource = scheme;
    this.publish();
    return this.state();
  }
  async set(value: unknown): Promise<DesktopColorSchemeState> {
    const scheme = parseColorScheme(value);
    const result = await this.platform.update({
      ...this.platform.state().preferences,
      colorScheme: scheme,
    });
    if (result.status !== "ready" || result.preferences.colorScheme !== scheme)
      throw new Error("Desktop color scheme could not be saved.");
    return this.state();
  }
  close(): void {
    this.theme.removeListener("updated", this.updated);
  }
  private publish(): void {
    const state = this.state();
    if (state.scheme !== this.previous?.scheme || state.resolved !== this.previous?.resolved) {
      this.previous = state;
      this.changed(state);
    }
  }
}
