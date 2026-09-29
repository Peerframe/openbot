import type { PluginTool } from "../plugin-api";

export function PluginToolList({ tools }: { tools: PluginTool[] }) {
  return (
    <div className="plugin-tool-list">
      {tools.map((tool) => (
        <details key={tool.name}>
          <summary>{tool.name}</summary>
          <p>{tool.description || "此工具未提供说明。"}</p>
          <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
          {tool.annotations ? (
            <>
              <p>以下是插件自报信息，不代表已获得授权。</p>
              <pre>{JSON.stringify(tool.annotations, null, 2)}</pre>
            </>
          ) : null}
        </details>
      ))}
    </div>
  );
}
