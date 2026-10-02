import type { KnowledgeProposal } from "@openbot/domain";
import { useEffect, useId, useState } from "react";
import { getKnowledgeProposals, reviewKnowledgeProposal } from "../api";

export function KnowledgeReviewPanel({
  botId,
  onChanged,
}: {
  botId: string;
  onChanged(): Promise<void>;
}) {
  const [proposals, setProposals] = useState<KnowledgeProposal[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit Owner refresh request.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    getKnowledgeProposals(botId)
      .then((items) => {
        if (active) setProposals(items);
      })
      .catch(() => {
        if (active) setError("暂时无法读取候选经验，请刷新后重试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [botId, revision]);
  const [showAll, setShowAll] = useState(false);
  const [reviewingId, setReviewingId] = useState<string>();
  const shown = showAll ? proposals : proposals.slice(0, 2);
  return (
    <section className="knowledge-review-panel" aria-label="候选经验审阅">
      <header className="ep-section-head">
        <h2>候选经验{proposals.length > 0 ? ` · ${proposals.length} 待你审阅` : ""}</h2>
        <span>
          <small>最新的在前；审阅前不会成为记忆，也不会用于后续任务</small>
          <button
            className="ep-text-button"
            type="button"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            刷新
          </button>
        </span>
      </header>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="ep-note">
          正在读取候选经验…
        </p>
      ) : proposals.length === 0 && !error ? (
        <p className="ep-note">没有待审阅的候选经验。</p>
      ) : null}
      {proposals.length > 0 ? (
        <div className={`knowledge-grid${showAll ? " is-all" : ""}`}>
          {shown.map((proposal) =>
            reviewingId === proposal.id ? (
              <div className="knowledge-card is-open" key={proposal.id}>
                <KnowledgeProposalReview
                  proposal={proposal}
                  onCancel={() => setReviewingId(undefined)}
                  onReviewed={async () => {
                    setReviewingId(undefined);
                    setProposals((items) => items.filter((item) => item.id !== proposal.id));
                    await onChanged();
                  }}
                />
              </div>
            ) : (
              <KnowledgeProposalCard
                key={proposal.id}
                proposal={proposal}
                onReview={() => setReviewingId(proposal.id)}
                onDismissed={async () => {
                  setProposals((items) => items.filter((item) => item.id !== proposal.id));
                  await onChanged();
                }}
              />
            ),
          )}
          {!showAll && proposals.length > 2 ? (
            <button type="button" className="knowledge-more" onClick={() => setShowAll(true)}>
              <strong>+{proposals.length - 2}</strong>
              查看全部
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ProposalSource({ proposal }: { proposal: KnowledgeProposal }) {
  return proposal.source?.kind === "task" ? (
    <>
      来源 Task：
      <a href={`#/tasks?task=${encodeURIComponent(proposal.source.taskId)}`}>
        {proposal.source.taskId}
      </a>
      {" · "}Work Run：<code>{proposal.source.runId}</code>
    </>
  ) : (
    <>
      来源频道 Run：<code>{proposal.sourceRunId}</code>
    </>
  );
}

/** A candidate at a glance. 忽略 rejects it without sending its content anywhere. */
function KnowledgeProposalCard({
  proposal,
  onReview,
  onDismissed,
}: {
  proposal: KnowledgeProposal;
  onReview(): void;
  onDismissed(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <article className="knowledge-card">
      <strong>{proposal.title}</strong>
      <p>{proposal.content}</p>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <footer>
        <small className="knowledge-source">
          <ProposalSource proposal={proposal} />
        </small>
        <button
          type="button"
          className="ob-pill is-small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await reviewKnowledgeProposal(proposal.botId, proposal.id, {
                decision: "reject",
                ownerReviewed: true,
              });
              await onDismissed();
            } catch {
              setError("没能确认已忽略，请刷新后再操作。");
              setBusy(false);
            }
          }}
        >
          忽略
        </button>
        <button type="button" className="ob-pill is-small is-primary" onClick={onReview}>
          审阅并保存
        </button>
      </footer>
    </article>
  );
}

export function KnowledgeProposalReview({
  proposal,
  onReviewed,
  onCancel,
}: {
  proposal: KnowledgeProposal;
  onReviewed(): Promise<void>;
  onCancel?: (() => void) | undefined;
}) {
  const [title, setTitle] = useState(proposal.title);
  const [content, setContent] = useState(proposal.content);
  const [modelUseEnabled, setModelUseEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  async function decide(decision: "accept" | "reject") {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await reviewKnowledgeProposal(
        proposal.botId,
        proposal.id,
        decision === "reject"
          ? { decision, ownerReviewed: true }
          : { decision, ownerReviewed: true, title, content, modelUseEnabled },
      );
      await onReviewed();
    } catch {
      setError("审阅未确认成功，请刷新查看当前状态后再操作。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="knowledge-proposal"
      onSubmit={(event) => {
        event.preventDefault();
        void decide("accept");
      }}
    >
      <p className="knowledge-source">
        <ProposalSource proposal={proposal} />
        {" · "}
        {new Date(proposal.createdAt).toLocaleString()}
      </p>
      <label className="ob-field" htmlFor={`${id}-title`}>
        经验标题
        <input
          id={`${id}-title`}
          required
          maxLength={160}
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="ob-field" htmlFor={`${id}-content`}>
        审阅并修改内容
        <textarea
          id={`${id}-content`}
          required
          maxLength={2000}
          value={content}
          disabled={busy}
          onChange={(event) => setContent(event.target.value)}
        />
      </label>
      <label className="ep-checkbox">
        <input
          type="checkbox"
          checked={modelUseEnabled}
          disabled={busy}
          onChange={(event) => setModelUseEnabled(event.target.checked)}
        />
        <span>允许此员工后续任务将这条记忆发送给配置的模型</span>
      </label>
      <small>保存为内部、不可迁移的记忆。未勾选时仅保存供你查看，可稍后编辑使用设置。</small>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <footer className="knowledge-proposal-actions">
        {onCancel ? (
          <button className="ob-pill is-small" type="button" disabled={busy} onClick={onCancel}>
            收起
          </button>
        ) : null}
        <button
          className="ob-pill is-small"
          type="button"
          disabled={busy}
          onClick={() => void decide("reject")}
        >
          拒绝并删除候选内容
        </button>
        <button className="ob-pill is-small is-primary" type="submit" disabled={busy}>
          {busy ? "处理中…" : "批准并保存记忆"}
        </button>
      </footer>
    </form>
  );
}
