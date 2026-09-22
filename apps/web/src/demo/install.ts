import type { DemoAdapter } from "./adapter";

/** Called only by isolated demo/fixture entries before importing product UI modules. */
export function installDemoTransport(adapter: DemoAdapter) {
  window.fetch = adapter.fetch;
  class DemoEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 1;
    readonly withCredentials = false;
    onopen: EventSource["onopen"] = null;
    onerror: EventSource["onerror"] = null;
    onmessage: EventSource["onmessage"] = null;
    private disconnect: () => void;
    constructor(readonly url: string) {
      super();
      this.disconnect = adapter.connect(this, url);
    }
    override dispatchEvent(event: Event) {
      const result = super.dispatchEvent(event);
      const source = this as unknown as EventSource;
      if (event.type === "open") this.onopen?.call(source, event);
      if (event.type === "error") this.onerror?.call(source, event);
      if (event.type === "message") this.onmessage?.call(source, event as MessageEvent);
      return result;
    }
    close() {
      this.readyState = 2;
      this.disconnect();
    }
  }
  window.EventSource = DemoEventSource as unknown as typeof EventSource;
  // Product preferences are harmless but the demo must not read or mutate another workspace's storage.
  const memory = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return memory.size;
    },
    clear: () => memory.clear(),
    key: (index) => [...memory.keys()][index] ?? null,
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
    removeItem: (key) => {
      memory.delete(key);
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: storage });
  if (navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException(
        "交互演示不录制声音；请在自己的工作区使用语音附件。",
        "NotAllowedError",
      );
    };
  document.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (!anchor) return;
    const url = new URL(anchor.href, location.href);
    event.preventDefault();
    const file = url.origin === location.origin ? adapter.download(url.pathname) : undefined;
    if (!file) return;
    event.stopPropagation();
    const blobUrl = URL.createObjectURL(
      new Blob([file.content], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = file.name;
    // This one listener owns downloads; avoid recursively intercepting the generated local link.
    link.addEventListener("click", (downloadEvent) => downloadEvent.stopPropagation());
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    window.dispatchEvent(new CustomEvent("openbot-demo:download", { detail: file.name }));
  });
}
