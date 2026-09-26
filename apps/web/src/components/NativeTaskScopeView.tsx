import { useEffect, useState } from "react";
import { getNativeTaskScope, type NativeTaskScope } from "../native-task-api";

export function NativeTaskScopeView({
  taskId,
  active,
  fresh,
}: {
  taskId: string;
  active: boolean;
  fresh: boolean;
}) {
  const [scope, setScope] = useState<NativeTaskScope | null>();
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh invalidates the previous bounded scope read.
  useEffect(() => {
    if (!active || !fresh) return;
    const controller = new AbortController();
    setError(false);
    void getNativeTaskScope(
      taskId,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    )
      .then((next) => {
        if (!controller.signal.aborted) setScope(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [taskId, active, fresh, revision]);
  return (
    <section className="native-task-scope-readonly" aria-label="已提交的任务范围">
      <h3>已提交的任务范围（只读）</h3>
      <p>
        范围在创建时固定，不能通过纠正或重试增加权限；当前执行授权与操作审批另以 Server 状态为准。
      </p>
      {!fresh && <p>当前离线或快照待同步；下列范围可能为上次读取结果。</p>}
      {error && <p role="alert">未能读取已提交范围，不能据此判断任务没有额外权限。</p>}
      {scope === undefined && !error && <p>正在读取已提交范围…</p>}
      {scope === null && <p>此任务没有显式原生范围；不能据此推断其他来源任务的权限。</p>}
      {scope && (
        <>
          <dl>
            <dt>知识</dt>
            <dd>{scope.knowledge ? "已授权" : "未授权"}</dd>
            <dt>插件</dt>
            <dd>{scope.plugins ? "已授权" : "未授权"}</dd>
            <dt>网页</dt>
            <dd>{scope.web ? "已授权" : "未授权"}</dd>
          </dl>
          <p>
            协作 Bot：
            {scope.collaboratorBotIds.length ? scope.collaboratorBotIds.join("、") : "未授权"}
          </p>
          <ul>
            {scope.attachments.map((file) => (
              <li key={file.id}>
                {file.name} · {file.mediaType} · {file.sizeBytes} 字节
                <br />
                SHA-256 <code>{file.sha256}</code>
                <br />
                元数据 SHA-256 <code>{file.metadataSha256}</code>
              </li>
            ))}
          </ul>
          {scope.attachments.length === 0 && <p>未选择附件。</p>}
          <small>
            范围 SHA-256 <code>{scope.sha256}</code>
          </small>
        </>
      )}
      <button
        type="button"
        disabled={!active || !fresh}
        onClick={() => setRevision((value) => value + 1)}
      >
        刷新已提交范围
      </button>
    </section>
  );
}
