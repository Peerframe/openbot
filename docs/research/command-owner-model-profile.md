# Owner model selection for command employees

2026-09-25. Narrow compatibility correction, before implementation.

Reuse docs/OPEN_SOURCE_REUSE.md's Python plugins/model connections and retained
model client entries; python-model-services.md, work-command-source-adapter.md
and work-command-authority.md. OpenBot MIT feature source
9cc73c9e78451e572f57d142d6b9caf62ccb78e2 supplies the existing DTO/editor and
CAS/audit behavior. Existing locked Pydantic2.13.5 (MIT), Zod4.6.2 (MIT),
React19.3.0 (MIT), PostgreSQL17.11
and cryptography are reused, with no new code/dependency from upstream.
Official validators documentation re-read:
https://docs.pydantic.dev/latest/concepts/validators/ and
https://zod.dev/api#superrefine . Existing source/tests/pins/release reviews are
retained; no changed validator algorithm or dependency upgrade requires a fork.

Root cause: CommandProfiles already requires an immutable explicit ModelSelection
for docker-linux, while Owner creation/update and UI limit selection to model.
Use the original local service/editor with a two-profile allowlist, model and
docker-linux. Continue rejecting explicit selection on none/macos-cua/lume-vm/coder.
Creation omission remains permitted as before; explicit null remains rejected.
Owner updates still require revision CAS, current enabled connection resolution,
single transaction and audit; explicit null update removes selection.

Crucially, model_connections.in_transaction stays model-only: Docker legacy
runs.model_selection/node_id remain NULL; CommandProfiles is sole command source
selection snapshot. NativeTaskScopeForm continues rejecting Docker. Merely
storing a model selection grants no execution, Node route, command capability
or approval. Missing trusted command configuration and missing model snapshot
continue refusing source admission. Default profile and legacy TS business
Server implementation are unchanged; shared DTO acceptance is metadata only.

No model/provider network, application installation or production activation.
Verify actual Owner API against isolated canonical PostgreSQL, denied Owner/CAS/
disabled connections/revocation, model projections and off/missing source gates;
use existing React interaction tests and shared schema regressions.

The original selector treats null as a usable Server default when a trusted legacy
connection exists. Docker cannot use this omission. Add allowDefault=false only
for Docker creation/editor; actual legacy connection IDs remain explicitly
selectable. The option defaults true for every existing model flow. Revocation
is still the existing Owner model:null update, never an implicit new model.

Actual Owner API also exposed a pre-existing missing configuration.model projection
in PostgresEmployeeKnowledge.profile. Reuse the already validated employee.model
value, rather than re-parsing or adding another storage field. No authority is
granted by this DTO. Final validation:78 Python checks against real canonical43 PG,
49 React/schema checks, Web/protocol typechecks. TestClient/jsdom are explicit
limits; no native command/engine/provider execution was run.
