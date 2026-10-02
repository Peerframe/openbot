import type { Approval, ApprovalDecision, Bot, Channel } from "@openbot/domain";
import { useState } from "react";
import { ApprovalCard } from "./ApprovalCard";

/**
 * 需要处理 in the right rail (LongLists): the approval that expires first is on top and the rest
 * are stacked behind it until the Owner opens them. Every card keeps its own 批准 / 拒绝; the stack
 * only changes what is visible, never what is decided.
 */
export function ApprovalStack({
  approvals,
  botFor,
  channelFor,
  onDecide,
}: {
  approvals: Approval[];
  botFor(approval: Approval): Bot | undefined;
  channelFor(approval: Approval): Channel | undefined;
  onDecide(approvalId: string, decision: ApprovalDecision): Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const ordered = [...approvals].sort(
    (left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt),
  );
  const stacked = !expanded && ordered.length > 1;
  const shown = stacked ? ordered.slice(0, 1) : ordered;
  return (
    <>
      <div
        className={`ci-approvals${stacked ? " is-stacked" : ""}`}
        data-behind={stacked ? Math.min(2, ordered.length - 1) : undefined}
      >
        {shown.map((approval) => (
          <ApprovalCard
            approval={approval}
            bot={botFor(approval)}
            channel={channelFor(approval)}
            onDecide={onDecide}
            key={approval.id}
          />
        ))}
      </div>
      {ordered.length > 1 ? (
        <button
          type="button"
          className="ci-more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起" : `展开另外 ${ordered.length - 1} 个 ›`}
        </button>
      ) : null}
    </>
  );
}
