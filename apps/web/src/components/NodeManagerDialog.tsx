import type { ExecutionNode, NodeEnrollmentToken, NodeIdentitySummary } from "@openbot/domain";
import { useCallback, useEffect, useState } from "react";
import {
  type ApiError,
  createNodeEnrollmentToken,
  listNodeIdentities,
  revokeNodeIdentity,
} from "../api";
import { CloseIcon, NodeIcon } from "./Icons";
import { useModalDialog } from "./useModalDialog";

export type NodeDisplayState = "online" | "offline" | "revoked";

export function nodeIdentityDisplayState(
  identity: NodeIdentitySummary,
  onlineNodes: ExecutionNode[],
): NodeDisplayState {
  if (identity.status === "revoked") return "revoked";
  return onlineNodes.some((node) => node.id === identity.nodeId) ? "online" : "offline";
}

/** Server-backed host enrollment state shared by the dialog and Settings → 工作主机. */
export function useNodeManager() {
  const [identities, setIdentities] = useState<NodeIdentitySummary[]>();
  const [error, setError] = useState<string>();
  const [nodeId, setNodeId] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<NodeEnrollmentToken>();
  const [copied, setCopied] = useState(false);
  const [confirmingNodeId, setConfirmingNodeId] = useState<string>();
  const [revokingNodeId, setRevokingNodeId] = useState<string>();

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setError(undefined);
    try {
      setIdentities(await listNodeIdentities(signal));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError((cause as ApiError).message ?? "无法读取工作主机。请稍后重试。");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  async function issue(event: React.FormEvent) {
    event.preventDefault();
    if (issuing) return;
    setIssuing(true);
    setIssued(undefined);
    setCopied(false);
    setError(undefined);
    try {
      setIssued(await createNodeEnrollmentToken(nodeId.trim()));
    } catch (cause) {
      setError((cause as ApiError).message ?? "无法创建配对令牌。请稍后重试。");
    } finally {
      setIssuing(false);
    }
  }

  async function copyEnrollment() {
    if (issued === undefined) return;
    const environment = enrollmentEnvironment(issued);
    try {
      await navigator.clipboard.writeText(environment);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("浏览器未允许复制。请手动选择下方内容。");
    }
  }

  async function revoke(nodeIdToRevoke: string) {
    if (revokingNodeId !== undefined) return;
    setRevokingNodeId(nodeIdToRevoke);
    setError(undefined);
    try {
      await revokeNodeIdentity(nodeIdToRevoke);
      setConfirmingNodeId(undefined);
      setIdentities((current) =>
        current?.map((identity) =>
          identity.nodeId === nodeIdToRevoke
            ? { ...identity, status: "revoked", connected: false, node: undefined }
            : identity,
        ),
      );
      await refresh();
    } catch (cause) {
      setError((cause as ApiError).message ?? "无法吊销工作主机。当前状态没有改变。");
    } finally {
      setRevokingNodeId(undefined);
    }
  }

  return {
    identities,
    error,
    nodeId,
    setNodeId,
    issuing,
    issued,
    copied,
    confirmingNodeId,
    setConfirmingNodeId,
    revokingNodeId,
    refresh,
    issue,
    copyEnrollment,
    revoke,
  };
}

export function NodeManagerDialog({
  onlineNodes,
  onClose,
}: {
  onlineNodes: ExecutionNode[];
  onClose(): void;
}) {
  const {
    identities,
    error,
    nodeId,
    setNodeId,
    issuing,
    issued,
    copied,
    confirmingNodeId,
    setConfirmingNodeId,
    revokingNodeId,
    refresh,
    issue,
    copyEnrollment,
    revoke,
  } = useNodeManager();
  const { dialogRef, closeDialog } = useModalDialog(onClose);

  return (
    <div className="dialog-backdrop">
      <dialog
        ref={dialogRef}
        className="create-dialog node-manager-dialog"
        aria-labelledby="node-manager-title"
      >
        <header className="dialog-header">
          <div>
            <h2 id="node-manager-title">工作主机</h2>
            <p>连接 Windows、macOS 或 Linux 电脑，让员工在专用工作环境中执行任务。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={closeDialog}>
            <CloseIcon />
          </button>
        </header>

        <div className="node-manager-body">
          <section className="node-enrollment-section" aria-labelledby="node-enrollment-title">
            <div className="node-manager-section-heading">
              <div>
                <h3 id="node-enrollment-title">配对新主机</h3>
                <p>令牌十分钟后过期，只显示一次。不要通过公开聊天或 Git 传递。</p>
              </div>
            </div>
            <form className="node-enrollment-form" onSubmit={issue}>
              <label>
                <span>Node ID</span>
                <input
                  autoFocus
                  maxLength={128}
                  pattern="[A-Za-z0-9][A-Za-z0-9._:-]*"
                  placeholder="office-linux-01"
                  required
                  value={nodeId}
                  onChange={(event) => setNodeId(event.target.value)}
                />
              </label>
              <button className="primary-button" type="submit" disabled={issuing}>
                {issuing ? "创建中…" : "创建配对令牌"}
              </button>
            </form>

            {issued ? (
              <section className="node-enrollment-result" aria-live="polite">
                <div>
                  <strong>仅显示这一次</strong>
                  <span>有效至 {formatNodeDate(issued.expiresAt)}</span>
                </div>
                <pre>{enrollmentEnvironment(issued)}</pre>
                <button className="secondary-button" type="button" onClick={copyEnrollment}>
                  {copied ? "已复制" : "复制启动配置"}
                </button>
                <p>在目标主机配置 Server 地址后加入以上两行，首次启动成功后立即删除令牌。</p>
              </section>
            ) : null}
          </section>

          <section className="node-identity-section" aria-labelledby="node-identities-title">
            <div className="node-manager-section-heading">
              <div>
                <h3 id="node-identities-title">已登记主机</h3>
                <p>在线状态来自实时连接；登记与吊销状态来自 Server 数据库。</p>
              </div>
              <button
                className="secondary-button node-refresh-button"
                type="button"
                disabled={identities === undefined}
                onClick={() => void refresh()}
              >
                刷新
              </button>
            </div>

            {identities === undefined && error === undefined ? (
              <p className="node-manager-empty" aria-live="polite">
                正在读取工作主机…
              </p>
            ) : null}
            {identities?.length === 0 ? (
              <p className="node-manager-empty">
                还没有登记主机。创建配对令牌后，在目标电脑启动 Node。
              </p>
            ) : null}
            {identities && identities.length > 0 ? (
              <NodeIdentityList
                identities={identities}
                onlineNodes={onlineNodes}
                confirmingNodeId={confirmingNodeId}
                revokingNodeId={revokingNodeId}
                onConfirm={setConfirmingNodeId}
                onCancel={() => setConfirmingNodeId(undefined)}
                onRevoke={(value) => void revoke(value)}
              />
            ) : null}
          </section>
        </div>

        {error ? (
          <p className="form-error node-manager-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="node-manager-footer">
          <span>
            完整说明：<code>docs/NODE_ENROLLMENT.md</code>
          </span>
          <button className="secondary-button" type="button" onClick={closeDialog}>
            完成
          </button>
        </footer>
      </dialog>
    </div>
  );
}

export function NodeIdentityList({
  identities,
  onlineNodes,
  confirmingNodeId,
  revokingNodeId,
  onConfirm,
  onCancel,
  onRevoke,
}: {
  identities: NodeIdentitySummary[];
  onlineNodes: ExecutionNode[];
  confirmingNodeId?: string | undefined;
  revokingNodeId?: string | undefined;
  onConfirm(nodeId: string): void;
  onCancel(): void;
  onRevoke(nodeId: string): void;
}) {
  const onlineById = new Map(onlineNodes.map((node) => [node.id, node]));
  return (
    <ul className="node-identity-list">
      {identities.map((identity) => {
        const liveNode = onlineById.get(identity.nodeId) ?? identity.node;
        const state = nodeIdentityDisplayState(identity, onlineNodes);
        const confirming = confirmingNodeId === identity.nodeId;
        const revoking = revokingNodeId === identity.nodeId;
        return (
          <li key={identity.nodeId} className={`node-identity-item ${state}`}>
            <span className="node-identity-icon">
              <NodeIcon />
            </span>
            <div className="node-identity-copy">
              <div>
                <strong>{liveNode?.name ?? identity.nodeId}</strong>
                <span className={`node-status ${state}`}>{nodeStateLabel(state)}</span>
              </div>
              <code>{identity.nodeId}</code>
              <small>
                {liveNode
                  ? [
                      platformLabel(liveNode.platform),
                      liveNode.architecture,
                      state === "online"
                        ? liveNode.activeRunIds.length > 0
                          ? `正在执行 ${liveNode.activeRunIds.length}/${liveNode.maxConcurrentRuns} 个任务`
                          : "空闲"
                        : `上次在线 ${formatNodeDate(liveNode.lastSeenAt)}`,
                    ].join(" · ")
                  : `登记于 ${formatNodeDate(identity.enrolledAt)}`}
              </small>
            </div>
            {identity.status === "active" ? (
              <div className="node-identity-actions">
                {confirming ? (
                  <>
                    <span className="node-revoke-warning">旧凭证将立即失效</span>
                    <button
                      className="node-danger-button"
                      type="button"
                      disabled={revoking}
                      onClick={() => onRevoke(identity.nodeId)}
                    >
                      {revoking ? "吊销中…" : "确认吊销"}
                    </button>
                    <button type="button" disabled={revoking} onClick={onCancel}>
                      取消
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => onConfirm(identity.nodeId)}>
                    吊销
                  </button>
                )}
              </div>
            ) : (
              <span className="node-revoked-at">{formatNodeDate(identity.revokedAt)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function enrollmentEnvironment(issued: NodeEnrollmentToken): string {
  return `OPENBOT_NODE_ID=${issued.nodeId}\nOPENBOT_NODE_ENROLLMENT_TOKEN=${issued.token}`;
}

function nodeStateLabel(state: NodeDisplayState): string {
  if (state === "online") return "在线";
  if (state === "revoked") return "已吊销";
  return "离线";
}

function platformLabel(platform: ExecutionNode["platform"]): string {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

export function formatNodeDate(value: string | undefined): string {
  if (value === undefined) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
