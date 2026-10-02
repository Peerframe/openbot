import type {
  EmployeeEvolutionEvent,
  EmployeeEvolutionEventType,
  EmployeeEvidenceKind,
} from "@openbot/domain";
import { useMemo, useState } from "react";

export type EvolutionArchiveFilter = "all" | EmployeeEvolutionEventType;

const filterOptions: Array<{ id: EvolutionArchiveFilter; label: string }> = [
  { id: "all", label: "全部变化" },
  { id: "created", label: "员工创建" },
  { id: "role_changed", label: "职责变化" },
  { id: "skill_discovered", label: "发现技能" },
  { id: "skill_verified", label: "验证技能" },
  { id: "skill_suspended", label: "暂停技能" },
  { id: "skill_revoked", label: "撤销技能" },
  { id: "configuration_changed", label: "配置变化" },
  { id: "imported", label: "员工导入" },
];

const validFilters = new Set<EvolutionArchiveFilter>(filterOptions.map((option) => option.id));

export function selectEvolutionArchiveEvents(
  events: EmployeeEvolutionEvent[],
  filter: EvolutionArchiveFilter,
  visibleCount = Number.POSITIVE_INFINITY,
): EmployeeEvolutionEvent[] {
  // Keep the Hermes-inspired journey truthful: reveal a dated history prefix, never a score or
  // inferred level. The Server event remains the only source of meaning and authority.
  const matching = events
    .filter((event) => filter === "all" || event.type === filter)
    .sort((left, right) => {
      const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    });
  const boundedCount = Math.max(0, Math.min(Math.floor(visibleCount), matching.length));
  return matching.slice(0, boundedCount).reverse();
}

export function EmployeeEvolutionArchive({ events }: { events: EmployeeEvolutionEvent[] }) {
  const [filter, setFilter] = useState<EvolutionArchiveFilter>("all");
  const [visibleCount, setVisibleCount] = useState<number>();
  const matchingEvents = useMemo(
    () => selectEvolutionArchiveEvents(events, filter),
    [events, filter],
  );
  const boundedVisibleCount =
    visibleCount === undefined
      ? matchingEvents.length
      : Math.min(visibleCount, matchingEvents.length);
  const visibleEvents = useMemo(
    () => selectEvolutionArchiveEvents(events, filter, boundedVisibleCount),
    [boundedVisibleCount, events, filter],
  );

  if (events.length === 0) {
    return (
      <div className="employee-empty">
        <strong>暂无进化记录</strong>
        <p>真实能力变化会形成可追溯事件。</p>
      </div>
    );
  }

  const cutoff = visibleEvents[0];
  return (
    <div className="employee-evolution-archive">
      <div className="employee-evolution-controls">
        <label>
          <span>变化类型</span>
          <select
            value={filter}
            onChange={(event) => {
              const next = event.target.value;
              if (!validFilters.has(next as EvolutionArchiveFilter)) return;
              setFilter(next as EvolutionArchiveFilter);
              setVisibleCount(undefined);
            }}
          >
            {filterOptions.map((option) => (
              <option value={option.id} key={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="employee-evolution-range">
          <span>时间范围</span>
          <input
            type="range"
            min={matchingEvents.length === 0 ? 0 : 1}
            max={Math.max(1, matchingEvents.length)}
            value={boundedVisibleCount}
            disabled={matchingEvents.length < 2}
            aria-valuetext={cutoff ? `截至 ${formatDateTime(cutoff.createdAt)}` : "没有匹配记录"}
            onChange={(event) => setVisibleCount(Number(event.target.value))}
          />
        </label>
        <p aria-live="polite">
          {matchingEvents.length === 0
            ? "没有匹配记录"
            : `显示 ${visibleEvents.length}/${matchingEvents.length} · 截至 ${
                cutoff ? formatDateTime(cutoff.createdAt) : "—"
              }`}
        </p>
      </div>

      {visibleEvents.length === 0 ? (
        <div className="employee-empty">
          <strong>没有匹配的变化</strong>
          <p>选择其他类型即可继续查看这名员工的进化档案。</p>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setFilter("all");
              setVisibleCount(undefined);
            }}
          >
            查看全部
          </button>
        </div>
      ) : (
        <ol className="employee-evolution-timeline employee-evolution-archive-list">
          {visibleEvents.map((event) => {
            const evidence = uniqueEvidenceReferences(event.evidence);
            return (
              <li key={event.id}>
                <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
                <span aria-hidden="true" />
                <article>
                  <header>
                    <strong>{event.title}</strong>
                    <span className="employee-evolution-type">{eventTypeLabel(event.type)}</span>
                  </header>
                  <p>{event.summary}</p>
                  <details>
                    <summary>
                      来源：{evidenceKindLabel(event.source)}
                      {evidence.length > 0 ? ` · ${evidence.length} 条证据` : " · 无附加证据"}
                    </summary>
                    <dl className="employee-evolution-provenance">
                      <div>
                        <dt>事件标识</dt>
                        <dd>{event.id}</dd>
                      </div>
                      <div>
                        <dt>来源标识</dt>
                        <dd>{event.sourceId ?? "未提供"}</dd>
                      </div>
                    </dl>
                    {evidence.length > 0 ? (
                      <ul className="employee-evolution-evidence">
                        {evidence.map((reference) => (
                          <li key={`${reference.kind}:${reference.id}`}>
                            <strong>{reference.label ?? reference.id}</strong>
                            <small>
                              {evidenceKindLabel(reference.kind)} · {reference.id}
                            </small>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="employee-evolution-no-evidence">
                        此事件没有附加证据引用；档案不会据此推断技能或权限。
                      </p>
                    )}
                  </details>
                </article>
              </li>
            );
          })}
        </ol>
      )}
      <p className="employee-evolution-credit">
        进化档案的可视化方向参考 Hermes Agent Learning Journey；事件与权限仍由 OpenBot 服务电脑
        独立管理。
      </p>
    </div>
  );
}

function eventTypeLabel(type: EmployeeEvolutionEventType): string {
  return filterOptions.find((option) => option.id === type)?.label ?? type;
}

function evidenceKindLabel(kind: EmployeeEvidenceKind): string {
  if (kind === "run") return "任务";
  if (kind === "artifact") return "产出";
  if (kind === "approval") return "审批";
  if (kind === "manual") return "Owner 手动记录";
  return "员工包导入";
}

function uniqueEvidenceReferences(
  references: EmployeeEvolutionEvent["evidence"],
): EmployeeEvolutionEvent["evidence"] {
  return [
    ...new Map(
      references.map((reference) => [`${reference.kind}:${reference.id}`, reference]),
    ).values(),
  ];
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
