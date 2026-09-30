import type { DesktopUpdateState } from "./runtime-contract.js";

export interface DesktopUpdaterPort {
  check(): Promise<{ available: boolean; version: string } | undefined>;
  download(): Promise<void>;
  install(): void;
  subscribe(
    listener: (event: {
      status: "downloaded" | "failed";
      version?: string;
      percent?: number;
    }) => void,
  ): () => void;
}
export class DesktopUpdateController {
  private current: DesktopUpdateState;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribe: (() => void) | undefined;
  constructor(
    private readonly port: DesktopUpdaterPort | undefined,
    unavailable: DesktopUpdateState["code"],
    private readonly confirm: (version: string) => Promise<boolean>,
    private readonly shutdown: () => Promise<void>,
  ) {
    this.current = port
      ? { status: "idle" }
      : { status: "unavailable", ...(unavailable ? { code: unavailable } : {}) };
    this.unsubscribe = port?.subscribe((event) => {
      if (event.percent !== undefined) {
        if (this.current.status === "downloading" && Number.isFinite(event.percent))
          this.current = { ...this.current, percent: Math.max(0, Math.min(100, event.percent)) };
      } else if (event.status === "downloaded" && validVersion(event.version))
        this.current = { status: "downloaded", version: event.version };
      else this.current = { status: "failed", code: "update_failed" };
    });
  }
  state(): DesktopUpdateState {
    return Object.freeze({ ...this.current });
  }
  async check(): Promise<DesktopUpdateState> {
    if (
      !this.port ||
      this.busy ||
      this.current.status === "downloaded" ||
      this.current.status === "installing"
    )
      return this.state();
    this.busy = true;
    this.current = { status: "checking" };
    try {
      const result = await this.port.check();
      if (result?.available && validVersion(result.version))
        this.current = { status: "available", version: result.version };
      else if (result?.available) this.current = { status: "failed", code: "update_failed" };
      else this.current = { status: "idle" };
    } catch {
      this.current = { status: "failed", code: "update_failed" };
    } finally {
      this.busy = false;
    }
    return this.state();
  }
  async download(): Promise<DesktopUpdateState> {
    if (!this.port || this.busy || this.current.status !== "available") return this.state();
    this.busy = true;
    this.current = {
      status: "downloading",
      ...(this.current.version ? { version: this.current.version } : {}),
      percent: 0,
    };
    try {
      await this.port.download();
      if (this.state().status !== "downloaded")
        this.current = { status: "failed", code: "update_failed" };
    } catch {
      this.current = { status: "failed", code: "update_failed" };
    } finally {
      this.busy = false;
    }
    return this.state();
  }
  async install(): Promise<DesktopUpdateState> {
    if (!this.port || this.busy || this.current.status !== "downloaded" || !this.current.version)
      return this.state();
    this.busy = true;
    try {
      if (!(await this.confirm(this.current.version))) return this.state();
      try {
        await this.shutdown();
      } catch {
        this.current = { status: "failed", code: "shutdown_failed" };
        return this.state();
      }
      this.current = {
        status: "installing",
        ...(this.current.version ? { version: this.current.version } : {}),
      };
      this.port.install();
    } catch {
      this.current = { status: "failed", code: "update_failed" };
    } finally {
      this.busy = false;
    }
    return this.state();
  }
  automatic(enabled: boolean) {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!enabled || !this.port) return;
    const run = async () => {
      await this.check();
      await this.download();
    };
    void run();
    this.timer = setInterval(
      () => {
        void run();
      },
      6 * 60 * 60 * 1000,
    );
    this.timer.unref();
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
  }
}
function validVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
  );
}
