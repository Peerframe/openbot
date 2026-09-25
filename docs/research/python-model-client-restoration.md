# Model connection client restoration

Baseline: root 482bdc5bea56c5b1a996492701b6dbb012d5691e plus its existing working-tree Web Vite
configuration, captured into this isolated packet before editing. Feature source:
9cc73c9e78451e572f57d142d6b9caf62ccb78e2, original OpenBot MIT (LICENSE retained in the packet).
Source copied/adapted: model-services domain/protocol DTOs, ModelSelector, ModelConnectionsDialog,
ModelServices.css, EmployeeModelEditor, API helpers and focused source tests. These are existing
OpenBot project sources, not externally copied code. Preserve the root LICENSE on integration.

Reviewed current docs/OPEN_SOURCE_REUSE.md, docs/research/model-service-presets.md, S6 model
preservation mapping and the already reviewed Python connection contracts. Existing dependencies
remain React19.3.0/ReactDOM19.3.0, Zod4.6.2, Vite8.3.0 and Vitest5.0.0. No install/framework change.
Use native form/dialog controls and existing useModalDialog/API request authority handling. Server
remains owner of secrets, endpoint authorization, revisions, model routing and runtime permission.

Decision: merge bounded existing components and DTO additions into the current App. Keep current
WorkTasksScreen/desktop setup/navigation/settings and default none profile. Restore a separate
model-services entry and explicit per-Bot model selection. No automatic inference/discovery, fallback
or credential persistence in browser storage. Retain the source distinction between metadata-only
model discovery and an explicitly labeled metered inference test. New ModelConnectionPreset type
avoids colliding with current singleton ModelProviderPreset; JSON payloads remain identical.

The coordinator also requested `Run.workTaskId` and the `#/tasks?task=<id>` supervision link before
freeze. This uses the existing WorkTasksEntry/WorkTasksScreen snapshot reader and polling lifecycle;
it adds no execution engine, model call or task creation. `none` and `model` share existing native
cancel/steer controls after the coordinator confirmed the Python endpoints support both profiles.

Browser sessions are investigation-only in this packet. Their original protocol/UI is not revived
without the matching Python/Worker Host authority and leased browser lifecycle.

Root integration found that widening the shared Run profile type also widened the retained
TypeScript Node router's `Exclude<..., 'none'>` type. Its reviewed fixed-profile switch already
returns no route for model work. Preserve that behavior explicitly for `model` and narrow the
Worker-only type to exclude both Server profiles; do not route a model task to a computer or
duplicate the Python model implementation in the compatibility server. Original routing tests
and the repository build remain the regression gate.
