// Sandboxed iframe that runs a plugin's own UI (MCP Apps) through AppBridge; every host capability
// is denied unless wired explicitly here.
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { useEffect, useRef, useState } from "react";
import { isBoundedPluginMessage, pluginProxyUrl } from "../plugin-app-sandbox";

/** No MCP client is passed to AppBridge: every host capability is denied unless wired explicitly. */
export function PluginAppFrame({
  html,
  title,
  readResource,
}: {
  html: string;
  title: string;
  readResource?: (uri: string, signal: AbortSignal) => Promise<ReadResourceResult>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const read = useRef(readResource);
  read.current = readResource;
  const [status, setStatus] = useState("正在启动隔离界面…");
  const [source] = useState(pluginProxyUrl);
  useEffect(() => {
    let alive = true;
    const lifetime = new AbortController();
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (alive) setStatus("插件未完成初始化，可关闭后重新打开。");
    }, 10000);
    void import("@modelcontextprotocol/ext-apps/app-bridge")
      .then(async ({ AppBridge, PostMessageTransport }) => {
        const target = frame.current?.contentWindow;
        if (!target || !alive) return;
        let messages = 0;
        const bound = (event: MessageEvent) => {
          if (event.source === target && (++messages > 512 || !isBoundedPluginMessage(event.data)))
            event.stopImmediatePropagation();
        };
        window.addEventListener("message", bound, true);
        const bridge = new AppBridge(
          null,
          { name: "OpenBot", version: "0.1.0" },
          read.current ? { serverResources: {} } : {},
        );
        bridge.onreadresource = async (params, extra) => {
          if (!read.current || !alive) throw new Error("Resource access unavailable");
          const result = await read.current(
            params.uri,
            AbortSignal.any([extra.signal, lifetime.signal]),
          );
          if (!alive) throw new Error("Plugin view closed");
          return result;
        };
        bridge.onsandboxready = () => {
          void bridge
            .sendSandboxResourceReady({
              html,
              sandbox: "allow-scripts",
              csp: { connectDomains: [], resourceDomains: [] },
            })
            .catch(() => {
              if (alive) setStatus("插件界面无法载入。");
            });
        };
        bridge.oninitialized = () => {
          clearTimeout(timer);
          if (alive) setStatus("隔离界面已连接 · 无网络和设备权限");
        };
        bridge.onerror = () => {
          if (alive) setStatus("插件通信失败，请重新打开界面。");
        };
        stop = () => {
          window.removeEventListener("message", bound, true);
          void bridge.close();
        };
        try {
          await bridge.connect(new PostMessageTransport(target, target));
        } catch {
          if (alive) setStatus("插件界面无法连接。");
        }
      })
      .catch(() => {
        if (alive) setStatus("插件界面组件无法加载。");
      });
    return () => {
      alive = false;
      lifetime.abort();
      clearTimeout(timer);
      stop?.();
    };
  }, [html]);
  return (
    <section className="plugin-app-view">
      <p role="status">{status}</p>
      <iframe
        ref={frame}
        title={title}
        src={source}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'"
      />
    </section>
  );
}
