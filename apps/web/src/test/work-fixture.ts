import type { WorkSnapshot } from "../work-api";

export function workFixture(change: Partial<WorkSnapshot> = {}): WorkSnapshot {
  return {
    id: "task-one",
    botId: "bot-one",
    objective: "Review the document",
    status: "queued",
    revision: 1,
    resultSummary: null,
    artifacts: [],
    authorityActive: true,
    cancelRequested: false,
    attention: null,
    usage: { tokenLimit: 10000, reservedTokens: 0, spentTokens: 0 },
    runs: [{ id: "run-one", ordinal: 1, status: "queued" }],
    actions: [],
    events: [],
    eventsTruncated: false,
    ...change,
  };
}
