import type { EmployeeProfile, ExecutionNode } from "@openbot/domain";
import { isActiveRun } from "../run-state";
import { NodeIcon } from "./Icons";

export function EmployeeProfileRail({
  profile,
  nodes,
}: {
  profile: EmployeeProfile | undefined;
  nodes: ExecutionNode[];
}) {
  const activeRun = profile?.records.runs.find(isActiveRun);
  const activeNode = nodes.find((node) => node.id === activeRun?.nodeId);

  return (
    <aside className="context-rail employee-profile-rail" aria-label="员工运行环境">
      <section>
        <h2>当前工作</h2>
        {activeRun ? (
          <div className="employee-current-run">
            <span className="status-dot active" />
            <div>
              <strong>{activeRun.title}</strong>
              <small>{activeRun.status}</small>
            </div>
          </div>
        ) : (
          <div className="employee-current-run empty">
            <span>◷</span>
            <div>
              <strong>没有运行中的任务</strong>
              <small>这名员工正在待命。</small>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>主机访问</h2>
        <dl className="employee-host-facts">
          <div>
            <dt>执行策略</dt>
            <dd>{profile?.configuration.executionProfile ?? "—"}</dd>
          </div>
          <div>
            <dt>当前主机</dt>
            <dd>{activeNode?.name ?? "未绑定"}</dd>
          </div>
          {activeNode ? (
            <div>
              <dt>平台</dt>
              <dd>
                {activeNode.platform} · {activeNode.architecture}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="employee-safety-note">
        <header>
          <NodeIcon />
          <h2>安全边界</h2>
        </header>
        <p>技能表示员工会做什么，不代表它有权操作电脑。</p>
        <p>每台工作主机都由本地策略、审批和短期能力单独授权。</p>
      </section>
    </aside>
  );
}
