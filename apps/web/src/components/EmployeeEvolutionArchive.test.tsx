import type { EmployeeEvolutionEvent } from "@openbot/domain";
import { describe, expect, it } from "vitest";
import { evolutionTitle, selectEvolutionArchiveEvents } from "./EmployeeEvolutionArchive";

const events: EmployeeEvolutionEvent[] = [
  {
    id: "event-3",
    botId: "employee-1",
    type: "skill_verified",
    title: "Verified source triangulation",
    summary: "The Owner reviewed the evaluation run.",
    source: "manual",
    sourceId: "review-3",
    evidence: [{ kind: "run", id: "run-3", label: "Evaluation run" }],
    createdAt: "2026-09-03T12:00:00.000Z",
  },
  {
    id: "event-1",
    botId: "employee-1",
    type: "created",
    title: "Employee created",
    summary: "The Employee identity was created.",
    source: "manual",
    evidence: [],
    createdAt: "2026-09-01T12:00:00.000Z",
  },
  {
    id: "event-2",
    botId: "employee-1",
    type: "skill_discovered",
    title: "Discovered source triangulation",
    summary: "A candidate skill was recorded.",
    source: "run",
    sourceId: "run-2",
    evidence: [{ kind: "artifact", id: "artifact-2" }],
    createdAt: "2026-09-02T12:00:00.000Z",
  },
];

describe("selectEvolutionArchiveEvents", () => {
  it("shows the newest page first", () => {
    expect(selectEvolutionArchiveEvents(events, "all", 2).map((event) => event.id)).toEqual([
      "event-3",
      "event-2",
    ]);
  });

  it("groups stored event types under the artboard's filters", () => {
    expect(selectEvolutionArchiveEvents(events, "skills").map((event) => event.id)).toEqual([
      "event-3",
      "event-2",
    ]);
    expect(selectEvolutionArchiveEvents(events, "role").map((event) => event.id)).toEqual([
      "event-1",
    ]);
    expect(selectEvolutionArchiveEvents(events, "imported")).toEqual([]);
  });
});

describe("evolutionTitle", () => {
  it("translates the Server's fixed English titles and keeps any other title", () => {
    expect(evolutionTitle({ title: "Employee created" })).toBe("加入团队");
    expect(evolutionTitle({ title: "Employee role updated" })).toBe("职责更新");
    expect(evolutionTitle({ title: "Skill verified" })).toBe("技能通过审核");
    expect(evolutionTitle({ title: "新增技能「读取更新日志」" })).toBe("新增技能「读取更新日志」");
  });
});
