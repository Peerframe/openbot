import type { DesktopSidebarMaterialState } from "./runtime-contract.js";

interface MaterialWindow {
  isDestroyed(): boolean;
  setVibrancy(material: "sidebar" | null): void;
  setBackgroundColor(color: string): void;
}

interface SidebarMaterialOptions {
  platform: string;
  window: MaterialWindow;
  backgroundColor?(): string;
  accessibility(): Readonly<{ reducedTransparency: boolean; highContrast: boolean }>;
  changed(state: DesktopSidebarMaterialState): void;
}

/** Keep the requested preference separate from mandatory accessibility overrides. */
export class SidebarMaterialController {
  #requested = false;
  #state: DesktopSidebarMaterialState = { status: "unavailable" };
  readonly #options: SidebarMaterialOptions;

  constructor(options: SidebarMaterialOptions) {
    this.#options = options;
  }

  setEnabled(input: unknown): DesktopSidebarMaterialState {
    if (typeof input !== "boolean") return { status: "unavailable" };
    this.#requested = input;
    return this.refresh();
  }

  refresh(): DesktopSidebarMaterialState {
    const { window, platform, accessibility } = this.#options;
    if (window.isDestroyed()) return this.#publish("unavailable");
    try {
      if (platform !== "darwin") {
        window.setBackgroundColor(this.#background());
        return this.#publish("unsupported");
      }
      const flags = accessibility();
      const status = !this.#requested
        ? "disabled"
        : flags.reducedTransparency || flags.highContrast
          ? "reduced"
          : "enabled";
      // Repaint even when material status is unchanged: theme changes alter the opaque fallback.
      window.setBackgroundColor(status === "enabled" ? "#00000000" : this.#background());
      if (status !== this.#state.status) {
        if (status === "enabled") {
          window.setVibrancy("sidebar");
          window.setBackgroundColor("#00000000");
        } else {
          // Paint a solid fallback before removing the native backdrop.
          window.setBackgroundColor(this.#background());
          window.setVibrancy(null);
        }
      }
      return this.#publish(status);
    } catch {
      try {
        window.setBackgroundColor(this.#background());
        window.setVibrancy(null);
      } catch {
        // A closing window can reject both the original update and its fallback.
      }
      return this.#publish("unavailable");
    }
  }

  #background(): string {
    return this.#options.backgroundColor?.() ?? "#ffffff";
  }

  #publish(status: DesktopSidebarMaterialState["status"]): DesktopSidebarMaterialState {
    if (this.#state.status !== status) {
      this.#state = Object.freeze({ status });
      this.#options.changed(this.#state);
    }
    return this.#state;
  }
}
