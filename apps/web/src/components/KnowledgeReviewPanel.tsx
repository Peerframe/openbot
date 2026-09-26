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
  return (
    <section className="knowledge-review-panel" aria-label="候选经验审阅">
      <header>
        <div>
          <h3>候选经验</h3>
          <p>来自已完成任务。审阅前不会成为记忆，也不会用于后续任务。</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          刷新候选经验
        </button>
      </header>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status">正在读取候选经验…</p>
      ) : proposals.length === 0 && !error ? (
        <p>没有待审阅的候选经验。</p>
      ) : null}
      {proposals.map((proposal) => (
        <KnowledgeProposalReview
          key={proposal.id}
          proposal={proposal}
          onReviewed={async () => {
            setProposals((items) => items.filter((item) => item.id !== proposal.id));
            await onChanged();
          }}
        />
      ))}
    </section>
  );
}

export function KnowledgeProposalReview({
  proposal,
  onReviewed,
}: {
  proposal: KnowledgeProposal;
  onReviewed(): Promise<void>;
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
      className="form-grid knowledge-proposal"
      onSubmit={(event) => {
        event.preventDefault();
        void decide("accept");
      }}
    >
      <p className="knowledge-source">
        {proposal.source?.kind === "task" ? (
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
        )}
        {" · "}
        {new Date(proposal.createdAt).toLocaleString()}
      </p>
      <label htmlFor={`${id}-title`}>
        <span>经验标题</span>
        <input
          id={`${id}-title`}
          required
          maxLength={160}
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label htmlFor={`${id}-content`}>
        <span>审阅并修改内容</span>
        <textarea
          id={`${id}-content`}
          required
          maxLength={2000}
          value={content}
          disabled={busy}
          onChange={(event) => setContent(event.target.value)}
        />
      </label>
      <label className="memory-model-use">
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
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "处理中…" : "批准并保存记忆"}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => void decide("reject")}
        >
          拒绝并删除候选内容
        </button>
      </footer>
    </form>
  );
}
