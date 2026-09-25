# Native Task scope UI

[English](native-task-ui.md) · [简体中文](native-task-ui.zh-CN.md)

- Status: Candidate UI; final product/browser integration is required.
- Date: 2026-09-25.
- Scope: Owner attachment inputs and immutable Task capability grants in the existing React task screen.
- Boundary: The Server retains all identity, scope capture, authorization, approvals and lifecycle checks.

## Reuse review

Reuses React/ReactDOM 19.3.0 / `1d34f91dfde6bba84d08b683aaba164c7194dacb` (MIT), Zod 4.6.2 (MIT), and the repository's existing Vitest/jsdom. The existing [React review](react-19.3-version-coherence.md), WorkTasksScreen lifecycle tests, Owner attachment DTO contract and channel attachment processing interactions were inspected before implementation. No new dependency or framework is introduced. No upstream source was copied; existing OpenBot UI code was narrowly adapted. Preserve the dependency licenses already shipped.

Primary references reviewed on 2026-09-25: [pinned React source](https://github.com/react/react/tree/v19.3.0), [event handlers](https://react.dev/learn/responding-to-events), and [effect cleanup](https://react.dev/reference/react/useEffect). Explicit mutations stay in event handlers. Bounded reads abort on scope/visibility changes and ignore late responses. The released renderer and existing form/HTTP adapter meet the requirement; a new uploader, state manager or renderer would duplicate supported functionality. This review does not introduce new rendering APIs affected by the open upstream issues already recorded in the React review.

## Behavior and integration

The existing task form now uploads Owner attachments, selects or unselects existing files, soft-deletes/restores them, and offers explicit extraction, OCR or transcription. Upload does not select or process a file automatically. PDF passwords are cleared after the explicit action, on offline/navigation and on unmount; they never enter Task input. Text/image/other limits remain 256 KiB/5 MiB/10 MiB, with eight selected files and 20 MiB total. Office/audio/video inputs must finish explicit processing before submission. Raw image/PDF input remains available without claiming the model has already consumed it.

The original request key freezes the complete submitted scope. Ambiguous creation keeps that body for explicit retry; known parameter/413 rejection permits a corrected new request. Attachment mutations are never replayed automatically. A lost mutation requires refreshing selected metadata before submitting. New tasks start with empty lists and false capability flags. Only none/model Bots appear, collaborators exclude the selected Bot, and at most 32 can be selected. Existing cancel, correction, approval and reconciliation meanings are unchanged.

`WorkTasksScreen.nativeCapabilitiesEnabled` defaults to false. The product composition may enable it only after the knowledge/plugin/web/collaboration adapters are integrated and validated. Both the workspace screen and the standalone WorkTasksEntry composition must make that decision explicitly. The standalone Bot reader now retains `computerProfile`; the workspace already supplies it. Scope UI defaults do not grant runtime authority.

Task lookup separately reads the immutable `GET /api/v1/tasks/{id}/scope`. It displays captured hashes and grants read-only, rejects malformed/cross-namespace metadata and discards obsolete/offline responses. A missing/failed scope read is never rendered as an empty grant. No local storage, channel identity or hidden provider call is added.

## Validation

Focused React DOM/jsdom and HTTP-adapter suites: 82 tests passed across WorkTasksScreen, WorkTasksScope, work-api, native-task-api and App.navigation. TypeScript passed. These are synthetic interaction tests with mocked HTTP, not real browser/API/provider acceptance. Root integration must perform the final browser and real Owner API journey.

Run from the repository root with installed pinned dependencies:

```sh
npm run typecheck --workspace @openbot/web
cd apps/web
../../node_modules/.bin/vitest run src/components/WorkTasksScreen.test.tsx src/components/WorkTasksScope.test.tsx src/native-task-api.test.ts src/work-api.test.ts src/App.navigation.test.tsx
```

The tests cover exact retry bodies, default grants, Bot filtering/self exclusion, upload/selection/deletion/restoration, explicit processing and transient passwords, per-file and aggregate limits, offline/unmount invalidation, stale task identities, read-only scope, session errors and retained multibyte 413 recovery. No PG, Temporal, VPS, model service, user profile or new browser installation was used.

## Integrated browser checkpoint

Root's expanded91 React/API checks and Web typecheck passed. Actual Chrome against the real
Python Owner API passed authentication,26-byte CSV upload/selection, task create, immutable
scope readback and explicit cancellation closing authority. Desktop and390px viewports were
inspected without horizontal overflow. A fresh follow-up Task verified create-another resets
the form after cancellation without the previous HTML-required-field tooltip. All three UI
Tasks were explicitly cancelled; the final console error list was empty. That UI fixture had
no Temporal/model service, so the check proves UI/API behavior, not inference. Native full
HTTP/PG/mTLS orchestration has its separate capability journey and evidence.
