import type { Bot } from "@openbot/domain";
import { useRef, useState } from "react";
import type { Plugin, PluginGrant } from "../plugin-api";

function grantsForBot(
  plugin: Plugin,
  botId: string,
): {
  tools: PluginGrant[];
  resources: string[];
  prompts: string[];
} {
  const grant = plugin.grants.find((item) => item.botId === botId);
  const toolNames = new Set(plugin.tools.map((tool) => tool.name));
  const resourceUris = new Set((plugin.resources ?? []).map((resource) => resource.uri));
  const promptNames = new Set((plugin.prompts ?? []).map((prompt) => prompt.name));
  return {
    tools: (grant?.tools ?? []).filter((item) => toolNames.has(item.name)),
    resources: (grant?.resources ?? []).filter((uri) => resourceUris.has(uri)),
    prompts: (grant?.prompts ?? []).filter((name) => promptNames.has(name)),
  };
}

function stableGrantSignature(input: {
  tools: PluginGrant[];
  resources: string[];
  prompts: string[];
}): string {
  const tools = [...input.tools].map((grant) => `${grant.name}:${grant.mode}`).sort();
  const resources = [...input.resources].sort();
  const prompts = [...input.prompts].sort();
  return JSON.stringify({ tools, resources, prompts });
}

/** Authoritative Bot + grant-authority identity for success-feedback binding. */
function pluginGrantAuthoritySnapshot(
  plugin: Plugin,
  botId: string,
  bots: Bot[],
): {
  botId: string;
  revision: string;
  available: boolean;
  grantSignature: string;
  authority: string;
} {
  const available = Boolean(botId) && bots.some((bot) => bot.id === botId);
  if (!botId || !available) {
    return {
      botId,
      revision: plugin.revision,
      available: false,
      grantSignature: "",
      authority: `unavailable:${botId}`,
    };
  }
  const granted = grantsForBot(plugin, botId);
  const grantSignature = stableGrantSignature(granted);
  return {
    botId,
    revision: plugin.revision,
    available: true,
    grantSignature,
    authority: `${plugin.revision}|${plugin.enabled ? "1" : "0"}|${grantSignature}`,
  };
}

export function PluginGrantEditor({
  plugin,
  bots,
  disabled,
  onSave,
  selectedBotId,
  onSelectedBotIdChange,
}: {
  plugin: Plugin;
  bots: Bot[];
  disabled: boolean;
  selectedBotId?: string | undefined;
  onSelectedBotIdChange?(botId: string): void;
  onSave(
    botId: string,
    tools: PluginGrant[],
    content: { resources: string[]; prompts: string[] },
  ): Promise<void>;
}) {
  // Sticky selection: only the Owner dropdown may change botId. Prefer parent-persisted
  // selection so remounts (details keep-alive gaps) do not fall back to bots[0].
  // selectedBotId is mount-initial only (from parent persistence map); user changes go
  // through setBotId which writes the map for the next remount.
  const [botId, setBotIdState] = useState(() => selectedBotId ?? bots[0]?.id ?? "");
  function setBotId(next: string) {
    setBotIdState(next);
    onSelectedBotIdChange?.(next);
  }
  const selectedBotAvailable = bots.some((bot) => bot.id === botId);
  const initial = grantsForBot(plugin, botId);
  const [grants, setGrants] = useState<PluginGrant[]>(initial.tools);
  const [resources, setResources] = useState<string[]>(initial.resources);
  const [prompts, setPrompts] = useState<string[]>(initial.prompts);
  const [saved, setSaved] = useState(false);
  const pendingSaveRef = useRef<{
    epoch: number;
    botId: string;
    signature: string;
  } | null>(null);
  // Sync draft only when Bot selection or plugin grant revision changes — not on every
  // new plugin object identity (same-revision reloads must keep dirty drafts).
  const grantSyncKey =
    !botId || !selectedBotAvailable ? `unavailable:${botId}` : `${botId}:${plugin.revision}`;
  const [syncedGrantKey, setSyncedGrantKey] = useState(grantSyncKey);
  if (grantSyncKey !== syncedGrantKey) {
    setSyncedGrantKey(grantSyncKey);
    if (!botId || !selectedBotAvailable) {
      setGrants([]);
      setResources([]);
      setPrompts([]);
      pendingSaveRef.current = null;
      if (saved) setSaved(false);
    } else {
      const next = grantsForBot(plugin, botId);
      setGrants(next.tools);
      setResources(next.resources);
      setPrompts(next.prompts);
      const pending = pendingSaveRef.current;
      const nextSignature = stableGrantSignature(next);
      if (pending && pending.botId === botId && pending.signature === nextSignature) {
        // Post-save authoritative snapshot confirmed our write — keep success feedback.
        pendingSaveRef.current = null;
        if (!saved) setSaved(true);
      } else {
        // External authorization sync (update apply, cleared grants, etc.).
        pendingSaveRef.current = null;
        if (saved) setSaved(false);
      }
    }
  }
  const authority = pluginGrantAuthoritySnapshot(plugin, botId, bots);
  const selectionRef = useRef(authority);
  selectionRef.current = authority;
  const saveEpochRef = useRef(0);
  function noteDraftEdit() {
    saveEpochRef.current += 1;
    pendingSaveRef.current = null;
    setSaved(false);
  }
  return (
    <form
      className="plugin-grant-editor"
      aria-label={`分配 ${plugin.name} 工具`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!botId || !selectedBotAvailable || disabled) return;
        const submittedBotId = botId;
        const submittedRevision = plugin.revision;
        const submittedSignature = stableGrantSignature({
          tools: grants,
          resources,
          prompts,
        });
        const epoch = saveEpochRef.current;
        pendingSaveRef.current = {
          epoch,
          botId: submittedBotId,
          signature: submittedSignature,
        };
        void onSave(botId, grants, { resources, prompts })
          .then(() => {
            // Bind "已保存" to Bot + availability + grant-authority identity. A divergent
            // sync clears pendingSaveRef; do not resurrect success after cleared grants.
            if (saveEpochRef.current !== epoch) return;
            if (selectionRef.current.botId !== submittedBotId || !selectionRef.current.available) {
              return;
            }
            const pending = pendingSaveRef.current;
            if (
              !pending ||
              pending.epoch !== epoch ||
              pending.botId !== submittedBotId ||
              pending.signature !== submittedSignature
            ) {
              return;
            }
            // If the authoritative snapshot already advanced, it must confirm our write.
            if (
              selectionRef.current.revision !== submittedRevision &&
              selectionRef.current.grantSignature !== submittedSignature
            ) {
              pendingSaveRef.current = null;
              return;
            }
            setSaved(true);
          })
          .catch(() => {
            if (pendingSaveRef.current?.epoch === epoch) pendingSaveRef.current = null;
          });
      }}
    >
      <h4>分配给 Bot</h4>
      <label>
        接收 Bot
        <select
          aria-label={`${plugin.name} 接收 Bot`}
          value={botId}
          disabled={disabled}
          onChange={(event) => {
            if (disabled) return;
            const next = event.target.value;
            if (next === botId) return;
            setBotId(next);
            noteDraftEdit();
          }}
        >
          {botId && !selectedBotAvailable ? (
            <option value={botId} disabled>
              （Bot 已不存在）
            </option>
          ) : null}
          {bots.map((bot) => (
            <option value={bot.id} key={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </label>
      {plugin.tools.map((tool) => (
        <label className="plugin-tool-grant" key={tool.name}>
          <span>{tool.name}</span>
          <select
            aria-label={`${tool.name} 调用权限`}
            disabled={disabled || !botId || !selectedBotAvailable}
            value={grants.find((grant) => grant.name === tool.name)?.mode ?? "none"}
            onChange={(event) => {
              const mode = event.target.value;
              setGrants((current) => [
                ...current.filter((grant) => grant.name !== tool.name),
                ...(mode === "read" || mode === "confirm"
                  ? [{ name: tool.name, mode } satisfies PluginGrant]
                  : []),
              ]);
              noteDraftEdit();
            }}
          >
            <option value="none">不授权</option>
            <option value="confirm">每次调用前确认</option>
            <option value="read">允许持续只读调用</option>
          </select>
        </label>
      ))}
      {(plugin.resources ?? []).map((resource) => (
        <label className="plugin-review-check" key={resource.uri}>
          <input
            type="checkbox"
            disabled={disabled || !botId || !selectedBotAvailable}
            checked={resources.includes(resource.uri)}
            onChange={(event) => {
              setResources((current) =>
                event.target.checked
                  ? [...current, resource.uri]
                  : current.filter((uri) => uri !== resource.uri),
              );
              noteDraftEdit();
            }}
          />
          {resource.mimeType === "text/html;profile=mcp-app" ? "界面" : "资源"}：{resource.name}
        </label>
      ))}
      {(plugin.prompts ?? []).map((prompt) => (
        <label className="plugin-review-check" key={prompt.name}>
          <input
            type="checkbox"
            disabled={disabled || !botId || !selectedBotAvailable}
            checked={prompts.includes(prompt.name)}
            onChange={(event) => {
              setPrompts((current) =>
                event.target.checked
                  ? [...current, prompt.name]
                  : current.filter((name) => name !== prompt.name),
              );
              noteDraftEdit();
            }}
          />
          提示词：{prompt.name}
        </label>
      ))}
      <p>
        只读权限由你判断并授权，不采用插件自报标签。可能写入或产生外部影响的工具应选择每次确认。
      </p>
      <button
        className="secondary-button"
        type="submit"
        disabled={disabled || !botId || !selectedBotAvailable}
      >
        保存 Bot 工具权限
      </button>
      {saved ? <span role="status">已保存</span> : null}
    </form>
  );
}
