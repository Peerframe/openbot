import type {
  EmployeeEvidenceKind,
  EmployeeEvolutionEvent,
  EmployeeEvolutionEventType,
} from "@openbot/domain";
import { useMemo, useState } from "react";

/** Filters of the ProfileEvolution artboard; each groups one or more stored event types. */
export type EvolutionArchiveFilter = "all" | "role" | "skills" | "configuration" | "imported";

const filterGroups: Array<{
  id: EvolutionArchiveFilter;
  label: string;
  types: EmployeeEvolutionEventType[] | "all";
}> = [
  { id: "all", label: "全部", types: "all" },
  { id: "role", label: "职责", types: ["created", "role_changed"] },
  {
    id: "skills",
    label: "技能",
    types: ["skill_discovered", "skill_verified", "skill_suspended", "skill_revoked"],
  },
  { id: "configuration", label: "配置", types: ["configuration_changed"] },
  { id: "imported", label: "导入", types: ["imported"] },
];

const PAGE = 20;

function matches(event: EmployeeEvolutionEvent, filter: EvolutionArchiveFilter) {
  const group = filterGroups.find((item) => item.id === filter);
  return !group || group.types === "all" || group.types.includes(event.type);
}

/**
 * Newest first, filtered, at most `limit`. The Server event is the only source of meaning and
 * authority: the archive shows dated facts, never a score or an inferred level.
 */
export function selectEvolutionArchiveEvents(
  events: EmployeeEvolutionEvent[],
  filter: EvolutionArchiveFilter,
  limit = Number.POSITIVE_INFINITY,
): EmployeeEvolutionEvent[] {
  return events
    .filter((event) => matches(event, filter))
    .sort((left, right) => {
      const byTime = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
    })
    .slice(0, Math.max(0, Math.floor(limit)));
}

const dayFormatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" });
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function dayLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return dayFormatter.format(date);
}

/** Dot colour marks state only: green for a verified skill, grey for a candidate. */
function markClass(type: EmployeeEvolutionEventType) {
  if (type === "skill_verified") return "is-verified";
  if (type === "skill_discovered") return "is-candidate";
  return "";
}

/**
 * 进化档案 (ProfileEvolution artboard). The direction is inspired by Hermes Agent's Learning
 * Journey; events and authority stay with the OpenBot 服务电脑.
 */
export function EmployeeEvolutionArchive({ events }: { events: EmployeeEvolutionEvent[] }) {
  const [filter, setFilter] = useState<EvolutionArchiveFilter>("all");
  const [limit, setLimit] = useState(PAGE);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        filterGroups.map((group) => [
          group.id,
          events.filter((event) => matches(event, group.id)).length,
        ]),
      ) as Record<EvolutionArchiveFilter, number>,
    [events],
  );
  const visible = useMemo(
    () => selectEvolutionArchiveEvents(events, filter, limit),
    [events, filter, limit],
  );
  const remaining = counts[filter] - visible.length;
  const days: Array<{ label: string; items: EmployeeEvolutionEvent[] }> = [];
  for (const event of visible) {
    const label = dayLabel(event.createdAt);
    const day = days.at(-1);
    if (day?.label === label) day.items.push(event);
    else days.push({ label, items: [event] });
  }

  return (
    <div className="ep-evolution">
      <div className="ep-filter-row">
        <fieldset className="ep-text-filters" aria-label="变化类型">
          {filterGroups.map((group) => (
            <button
              type="button"
              key={group.id}
              aria-pressed={filter === group.id}
              onClick={() => {
                setFilter(group.id);
                setLimit(PAGE);
              }}
            >
              {group.label} {counts[group.id]}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="ep-evolution-grid">
        <div className="ep-evolution-list">
          {events.length === 0 ? (
            <p className="ep-empty">暂无进化记录。真实能力变化会形成可追溯事件。</p>
          ) : visible.length === 0 ? (
            <p className="ep-empty">没有这类变化。</p>
          ) : (
            days.map((day) => (
              <section key={day.label} aria-label={day.label}>
                <h3 className="ep-day">{day.label}</h3>
                <ol className="ep-card ep-events">
                  {day.items.map((event) => (
                    <EvolutionEvent event={event} key={event.id} />
                  ))}
                </ol>
              </section>
            ))
          )}
          {remaining > 0 ? (
            <button type="button" className="ep-more" onClick={() => setLimit(limit + PAGE)}>
              显示更早的 {Math.min(PAGE, remaining)} 条 ›
            </button>
          ) : null}
        </div>
        <aside className="ep-aside">
          <h3 className="ep-day">关于这份档案</h3>
          <div className="ep-card ep-aside-card">
            <span>只记录真实发生、能追溯来源的变化：职责、配置和技能。</span>
            <span>不展示模型的原始思维链；等级和外观也不代表权限。</span>
            <span>记录按天分组，一次显示 {PAGE} 条，往下再加载。</span>
            <small>成长方向受 Hermes Agent 的 Learning Journey 启发。</small>
          </div>
        </aside>
      </div>
    </div>
  );
}

function EvolutionEvent({ event }: { event: EmployeeEvolutionEvent }) {
  const evidence = uniqueEvidenceReferences(event.evidence);
  return (
    <li className="ep-event">
      <i className={markClass(event.type)} aria-hidden="true" />
      <div>
        <strong>{event.title}</strong>
        {event.summary ? <small>{event.summary}</small> : null}
        <details>
          <summary>
            <span className="ob-tag">
              {evidenceKindLabel(event.source)}
              {evidence.length > 0 ? ` · ${evidence.length} 条证据` : ""}
            </span>
          </summary>
          <dl className="ep-provenance">
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
            <ul className="ep-evidence">
              {evidence.map((reference) => (
                <li key={`${reference.kind}:${reference.id}`}>
                  {reference.label ?? reference.id}
                  <small>
                    {evidenceKindLabel(reference.kind)} · {reference.id}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <small>没有附加证据；档案不会据此推断技能或权限。</small>
          )}
        </details>
      </div>
      <time dateTime={event.createdAt}>{timeFormatter.format(new Date(event.createdAt))}</time>
    </li>
  );
}

function evidenceKindLabel(kind: EmployeeEvidenceKind): string {
  if (kind === "run") return "来自任务";
  if (kind === "artifact") return "来自产出";
  if (kind === "approval") return "来自确认";
  if (kind === "manual") return "你手动记录";
  return "Bot 模板导入";
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
