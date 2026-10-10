// 配对一台工作电脑 dialog (DialogPairHost artboard): issue a one-time pairing token and list paired
// work computers. Also the shared host-enrollment hook used by Settings → 工作主机.
import type { ExecutionNode, NodeEnrollmentToken, NodeIdentitySummary } from "@openbot/domain";
import { useCallback, useEffect, useState } from "react";
import {
  type ApiError,
  createNodeEnrollmentToken,
  listNodeIdentities,
  revokeNodeIdentity,
} from "../api";
import { Dialog } from "./Dialog";
import { NodeIcon } from "./Icons";
import "./NodeManagerDialog.css";

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

/**
 * 配对一台工作电脑 (DialogPairHost artboard). The pairing token is issued by the 服务电脑, valid
 * for ten minutes and shown once; the screen masks it and 复制启动配置 copies it in full. Online
 * state comes from the live connection; enrollment and revocation are the Server's records.
 */
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
    issue,
    copyEnrollment,
    revoke,
  } = useNodeManager();
  const [reveal, setReveal] = useState(false);
  const remaining = useCountdown(issued?.expiresAt);
  const onlineById = new Map(onlineNodes.map((node) => [node.id, node]));

  return (
    <Dialog
      title="配对一台工作电脑"
      intro="让 Bot 在一台专用电脑上执行任务。配对令牌十分钟内有效。"
      width={600}
      className="node-manager-dialog"
      onClose={onClose}
      footer={
        <button type="button" className="ob-pill is-large" onClick={onClose}>
          完成
        </button>
      }
    >
      {issued ? (
        <section className="ob-dialog-config" aria-live="polite">
          <header>
            <strong>启动配置 · 只显示这一次</strong>
            <small className="is-warning">
              {remaining === undefined || remaining > 0
                ? `${formatCountdown(remaining ?? 0)} 后过期`
                : "已过期，请重新创建"}
            </small>
          </header>
          <pre>{reveal ? enrollmentEnvironment(issued) : maskedEnvironment(issued)}</pre>
          <div>
            <button
              type="button"
              className="ob-pill is-small is-primary"
              onClick={async () => {
                await copyEnrollment();
              }}
            >
              {copied ? "已复制" : "复制启动配置"}
            </button>
            <small>
              在目标电脑上加入这两行再启动；首次连上后立刻删掉令牌。不要通过聊天或 Git 传递。
            </small>
          </div>
          {!reveal && error ? (
            <button type="button" className="ob-dialog-text-button" onClick={() => setReveal(true)}>
              显示完整内容以便手动复制
            </button>
          ) : null}
        </section>
      ) : (
        <form className="ob-dialog-pair" onSubmit={issue}>
          <label className="ob-field">
            给这台电脑起个编号
            <input
              // biome-ignore lint/a11y/noAutofocus: the dialog opens to pair a computer.
              autoFocus
              maxLength={128}
              pattern="[A-Za-z0-9][A-Za-z0-9._:-]*"
              placeholder="office-linux-01"
              required
              value={nodeId}
              onChange={(event) => setNodeId(event.target.value)}
            />
          </label>
          <button type="submit" className="ob-pill is-large is-primary" disabled={issuing}>
            {issuing ? "正在创建…" : "创建配对令牌"}
          </button>
        </form>
      )}

      <section className="ob-dialog-section" aria-labelledby="node-identities-title">
        <h3 id="node-identities-title">已登记的电脑 · {identities?.length ?? 0}</h3>
        {identities === undefined && error === undefined ? (
          <p className="ob-dialog-empty" aria-live="polite">
            正在读取工作电脑…
          </p>
        ) : null}
        {identities?.length === 0 ? (
          <p className="ob-dialog-empty">还没有登记的电脑。创建配对令牌后，在目标电脑上启动。</p>
        ) : null}
        {identities && identities.length > 0 ? (
          <ul className="ob-dialog-rows">
            {identities.map((identity) => {
              const live = onlineById.get(identity.nodeId) ?? identity.node;
              const state = nodeIdentityDisplayState(identity, onlineNodes);
              const confirming = confirmingNodeId === identity.nodeId;
              const revoking = revokingNodeId === identity.nodeId;
              return (
                <li key={identity.nodeId}>
                  <span className="ob-dialog-file-type" aria-hidden="true">
                    <NodeIcon />
                  </span>
                  <span>
                    <strong>{live?.name ?? identity.nodeId}</strong>
                    <small>
                      {live
                        ? [
                            platformLabel(live.platform),
                            `${live.activeRunIds.length}/${live.maxConcurrentRuns} 个任务`,
                            state === "online" ? "刚刚" : formatNodeDate(live.lastSeenAt),
                          ].join(" · ")
                        : `登记于 ${formatNodeDate(identity.enrolledAt)}`}
                    </small>
                  </span>
                  <span className="ob-dialog-row-actions">
                    <span className={`ob-dialog-state is-${state}`}>{nodeStateLabel(state)}</span>
                    {identity.status !== "active" ? null : confirming ? (
                      <>
                        <small className="is-danger">旧凭证将立即失效</small>
                        <button
                          type="button"
                          className="ob-pill is-small is-danger"
                          disabled={revoking}
                          onClick={() => void revoke(identity.nodeId)}
                        >
                          {revoking ? "正在吊销…" : "确认吊销"}
                        </button>
                        <button
                          type="button"
                          className="ob-pill is-small"
                          disabled={revoking}
                          onClick={() => setConfirmingNodeId(undefined)}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="ob-pill is-small"
                        onClick={() => setConfirmingNodeId(identity.nodeId)}
                      >
                        吊销
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {error ? (
        <p className="ob-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      <small className="ob-dialog-foot-note">
        在线状态来自实时连接；登记与吊销记录在服务电脑上。吊销后旧凭证立即失效。
      </small>
    </Dialog>
  );
}

function useCountdown(until: string | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return until === undefined ? undefined : Math.max(0, Date.parse(until) - now);
}

function formatCountdown(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The token on screen keeps only its last four characters; copying uses the full value. */
function maskedEnvironment(issued: NodeEnrollmentToken): string {
  const token = issued.token;
  const masked =
    token.length > 8 ? `${token.slice(0, 5)}${"•".repeat(16)}${token.slice(-4)}` : "••••";
  return `OPENBOT_NODE_ID=${issued.nodeId}\nOPENBOT_NODE_ENROLLMENT_TOKEN=${masked}`;
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
