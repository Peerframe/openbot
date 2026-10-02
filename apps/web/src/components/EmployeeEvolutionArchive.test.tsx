import type { EmployeeEvolutionEvent } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmployeeEvolutionArchive, selectEvolutionArchiveEvents } from "./EmployeeEvolutionArchive";

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

describe("EmployeeEvolutionArchive", () => {
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

  it("counts each filter", () => {
    const html = renderToStaticMarkup(<EmployeeEvolutionArchive events={events} />);
    expect(html).toContain("全部 3");
    expect(html).toContain("技能 2");
    expect(html).toContain("导入 0");
  });

  it("renders complete provenance without turning evidence references into implicit fetches", () => {
    const html = renderToStaticMarkup(<EmployeeEvolutionArchive events={events} />);

    expect(html).toContain("Evaluation run");
    expect(html).toContain("run-3");
    expect(html).toContain("artifact-2");
    expect(html).toContain("Hermes Agent");
    expect(html).not.toContain("href=");
  });
});
