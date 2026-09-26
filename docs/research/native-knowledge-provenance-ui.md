# Native knowledge provenance UI

[English](native-knowledge-provenance-ui.md) · [简体中文](native-knowledge-provenance-ui.zh-CN.md)

- Date: 2026-09-25.
- Status: Candidate display adapter; final product integration remains required.
- Scope: Distinguish native Task/Work Run provenance from legacy channel Run provenance in Owner knowledge review and accepted memory.

## Reuse and contract

This bounded extension reuses the [native Task UI review](native-task-ui.md), React/ReactDOM 19.3.0 / `1d34f91dfde6bba84d08b683aaba164c7194dacb` (MIT), the existing domain package and knowledge review/profile components. The actual Python `employee_knowledge._proposal_source` and `work_native_knowledge` accepted-memory records were inspected before coding. The existing `#/tasks?task=...` route is reused. Primary renderer references remain [pinned React source](https://github.com/react/react/tree/v19.3.0), [explicit event handlers](https://react.dev/learn/responding-to-events) and [effect lifecycle](https://react.dev/reference/react/useEffect). No new dependency, authority protocol or framework is introduced. No upstream source was copied; existing OpenBot UI is narrowly adapted. Existing licenses remain unchanged.

`KnowledgeProposal` is an exclusive union: a channel proposal retains `sourceRunId`; a native proposal carries `source: {kind: "task", taskId, runId}` and no legacy `sourceRunId`. The native UI links the actual Task and separately labels the Work Run. It never substitutes a Work Run into a channel Run field. The existing Owner review endpoint and exact accept/reject body remain unchanged, including default `modelUseEnabled: false`. Following a display link grants no authority; the destination reauthenticates through the existing Owner API.

Accepted native memory with `provenance.source: "reviewed-work-proposal"` displays `sourceTaskId` as a Task link and `sourceWorkRunId` as the Work Run. Incomplete native provenance is shown as incomplete, never inferred from a legacy fallback. Channel proposal/memory provenance remains visible as its original Run; manually authored Owner memory gains no synthetic source. React escapes text and the hash route encodes identities.

## Verification

KnowledgeReviewPanel and EmployeeProfileView: 16 tests passed, including seven native/channel compatibility cases. The isolated candidate domain build and Web TypeScript check passed; changed-file Biome lint passed. The domain declarations were built inside the isolated test mirror before checking the Web candidate. This is React DOM/jsdom and static-render evidence with synthetic records, not a real browser/Server journey. Root owns final API/browser integration. No server, provider, PG, Temporal or user profile was used.

```sh
npm run build --workspace @openbot/domain
npm run typecheck --workspace @openbot/web
cd apps/web
../../node_modules/.bin/vitest run src/components/KnowledgeReviewPanel.test.tsx src/components/EmployeeProfileView.test.tsx --maxWorkers=2
```
