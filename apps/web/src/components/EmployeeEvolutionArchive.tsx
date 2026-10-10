// Helpers for the Bot rail's 工作 → 成长 list: filter, label and date the Server's evolution events.
import type {
  EmployeeEvidenceKind,
  EmployeeEvolutionEvent,
  EmployeeEvolutionEventType,
} from "@openbot/domain";

/**
 * Evolution events for the Bot rail 工作 → 成长. The direction is inspired by Hermes Agent's
 * Learning Journey; events and authority stay with the OpenBot 服务电脑.
 */

/** Filters of the former ProfileEvolution artboard; each groups stored event types. */
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
export function evolutionMarkClass(type: EmployeeEvolutionEventType) {
  if (type === "skill_verified") return "is-verified";
  if (type === "skill_discovered") return "is-candidate";
  return "";
}

/**
 * The Server writes fixed English titles into evolution events (identity_store, profile_details,
 * model_connections, employee_portability, employee_knowledge), and existing workspaces already
 * hold them, so they are translated on display. Any other title is shown as stored.
 */
const storedTitles: Record<string, string> = {
  "Employee created": "加入团队",
  "Employee role updated": "职责更新",
  "Profile updated": "资料更新",
  "Employee model updated": "换了模型",
  "Employee imported": "从 Bot 模板导入",
  "Skill discovered": "发现候选技能",
  "Skill verified": "技能通过审核",
  "Skill suspended": "技能已暂停",
  "Skill revoked": "技能已撤销",
};

export function evolutionTitle(event: Pick<EmployeeEvolutionEvent, "title">): string {
  return storedTitles[event.title] ?? event.title;
}

/** 今天 14:20, 昨天 09:05 or 9月3日 14:20. */
export function evolutionWhen(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${dayLabel(value)} ${timeFormatter.format(date)}`;
}

export function evidenceKindLabel(kind: EmployeeEvidenceKind): string {
  if (kind === "run") return "来自任务";
  if (kind === "artifact") return "来自产出";
  if (kind === "approval") return "来自确认";
  if (kind === "manual") return "你手动记录";
  return "Bot 模板导入";
}

export function uniqueEvidenceReferences(
  references: EmployeeEvolutionEvent["evidence"],
): EmployeeEvolutionEvent["evidence"] {
  return [
    ...new Map(
      references.map((reference) => [`${reference.kind}:${reference.id}`, reference]),
    ).values(),
  ];
}
