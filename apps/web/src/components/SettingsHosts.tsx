// Settings → 工作主机 (SettingsHosts artboard): paired work computers, their live state, and pairing.
import type { ExecutionNode } from "@openbot/domain";
import { type ReactNode, useEffect, useState } from "react";
import { getWorkspace } from "../api";
import {
  enrollmentEnvironment,
  formatNodeDate,
  NodeIdentityList,
  useNodeManager,
} from "./NodeManagerDialog";
import { SettingsHeaderAction } from "./SettingsHeaderAction";
import { SettingsSearch, useSettingsSearch } from "./SettingsSearch";

/**
 * Settings → 工作主机 (SettingsHosts artboard). Enrollment and revocation stay Server-owned;
 * the one-time token is shown once and never stored by the client.
 */
export function SettingsHosts({ children }: { children?: ReactNode }) {
  const manager = useNodeManager();
  const [pairing, setPairing] = useState(false);
  const [onlineNodes, setOnlineNodes] = useState<ExecutionNode[]>([]);

  useEffect(() => {
    // Live connection and task load come from the workspace snapshot; enrollment from the Server.
    const controller = new AbortController();
    getWorkspace(controller.signal)
      .then((workspace) => setOnlineNodes(workspace.nodes))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const active = manager.identities?.filter((identity) => identity.status === "active").length;
  const search = useSettingsSearch(manager.identities?.length ?? 0);
  const shownIdentities = manager.identities?.filter((identity) =>
    search.matches(`${identity.node?.name ?? ""} ${identity.nodeId}`),
  );

  return (
    <>
      <SettingsHeaderAction>
        <button
          type="button"
          className="ob-pill is-primary"
          aria-expanded={pairing}
          onClick={() => setPairing((open) => !open)}
        >
          配对新主机
        </button>
      </SettingsHeaderAction>

      {pairing ? (
        <section className="settings-group" aria-labelledby="settings-pairing-title">
          <h3 id="settings-pairing-title">配对新主机</h3>
          <form className="settings-card settings-pairing-form" onSubmit={manager.issue}>
            <label className="ob-field">
              主机 ID
              <input
                // biome-ignore lint/a11y/noAutofocus: the owner just asked to pair a host.
                autoFocus
                maxLength={128}
                pattern="[A-Za-z0-9][A-Za-z0-9._:-]*"
                placeholder="office-linux-01"
                required
                value={manager.nodeId}
                onChange={(event) => manager.setNodeId(event.target.value)}
              />
            </label>
            <button className="ob-pill is-primary" type="submit" disabled={manager.issuing}>
              {manager.issuing ? "创建中…" : "创建配对令牌"}
            </button>
          </form>
        </section>
      ) : null}

      {manager.issued ? (
        <section className="settings-group" aria-live="polite">
          <h3>刚创建的配对令牌</h3>
          <div className="settings-card settings-token">
            <div className="settings-token-heading">
              <span className="settings-token-copy">
                <strong>只显示这一次</strong>
                <small>
                  有效至 {formatNodeDate(manager.issued.expiresAt)}。不要通过公开聊天或 Git 传递。
                </small>
              </span>
              <button className="ob-pill is-small" type="button" onClick={manager.copyEnrollment}>
                {manager.copied ? "已复制" : "复制启动配置"}
              </button>
            </div>
            <pre>{enrollmentEnvironment(manager.issued)}</pre>
            <small>在目标主机的配置里加入这两行，首次启动成功后立即删除令牌。</small>
          </div>
        </section>
      ) : null}

      <section className="settings-group settings-hosts" aria-labelledby="settings-hosts-title">
        <div className="settings-group-heading">
          <h3 id="settings-hosts-title">已登记{active !== undefined ? ` · ${active} 台` : ""}</h3>
          <button
            type="button"
            disabled={manager.identities === undefined}
            onClick={() => void manager.refresh()}
          >
            刷新
          </button>
        </div>
        {manager.identities === undefined && manager.error === undefined ? (
          <p className="settings-empty" aria-live="polite">
            正在读取工作主机…
          </p>
        ) : null}
        {manager.identities?.length === 0 ? (
          <p className="settings-empty">
            还没有登记主机。点「配对新主机」创建令牌，再在目标电脑启动 Node。
          </p>
        ) : null}
        <SettingsSearch search={search} count={manager.identities?.length ?? 0} noun="主机" />
        {search.active && shownIdentities?.length === 0 ? (
          <p className="settings-empty">没有匹配的主机。</p>
        ) : null}
        {shownIdentities && shownIdentities.length > 0 ? (
          <div className="settings-group-rows">
            <NodeIdentityList
              identities={shownIdentities}
              onlineNodes={onlineNodes}
              confirmingNodeId={manager.confirmingNodeId}
              revokingNodeId={manager.revokingNodeId}
              onConfirm={manager.setConfirmingNodeId}
              onCancel={() => manager.setConfirmingNodeId(undefined)}
              onRevoke={(value) => void manager.revoke(value)}
            />
          </div>
        ) : null}
        {manager.error ? (
          <p className="form-error" role="alert">
            {manager.error}
          </p>
        ) : null}
        <p className="settings-footnote">
          在线状态来自实时连接，登记与吊销状态来自服务电脑。吊销后旧凭证立即失效。
        </p>
      </section>
      {children}
    </>
  );
}
