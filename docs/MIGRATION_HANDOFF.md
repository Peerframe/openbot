# Architecture migration handoff — 2026-09-24

## Current short handoff (`81bd82c`)

- Completed: the control-side effect seam now admits an immutable Action once, then uses authoritative lookup and trusted receipt verification on replay. A separate readback records an existing effect after cancel/revoke without a new grant. Codex corrected a concurrent-resolution status race after the dsh draft. `81bd82c` also bounds raw lookup JSON before verification. The owned PostgreSQL/HTTP entry passed 299 cases with one optional Temporal-SDK skip; `npm run check` passed, with Turbo lint/typecheck/test and build tasks served from cache.
- Open: this helper is not wired into a production Temporal Worker or a real provider. S3 still needs per-Run Runtime/Worker composition, granular model/tool activities, approval waits, external-result finality, multi-Run continuation and crash recovery. S2 parity, S4/TASK020 real Linux/runsc and S5–S7 remain open.
- Invariants: Python control owns identity, authorization, Task/Action facts, approvals, budget and artifacts; Temporal owns continuation; Runtime/Worker gain no authority. Unknown writes require authoritative lookup or remain unknown. A negative receipt must prove external finality, not merely an empty read. No production cutover or release yet.
- Next input: `81bd82c`, `apps/server-python/src/openbot_server/{work_effects.py,work_temporal_activity.py}`, `apps/agent-runtime-python/src/openbot_agent_runtime/{executor.py,sdk_ports.py}`, and the last section of `docs/research/work-temporal-journey.md`. Preserve unrelated dirty model-service files, `docs/OPEN_SOURCE_REUSE.md` and `experiments/linux-execution/`. Use the older stage notes below only for a specific failure.

## Earlier stage evidence (retained)

Branch: `codex/architecture-migration`. Current S3 activity-scoped claim: `3ece362`; prior claim boundary: `13fb278`; activity binding: `8df7c89`; attempt provenance: `4160f26`; chain binding: `69b5faf`; S2 shell boundary: `b2de930`. Start with this handoff and current code; read older logs only for a specific failure.

## Completed

- ADR 0046 selects Temporal as the target recovery owner; production remains unchanged. Dispatch durably reserves before the first start and inspects original history on redelivery without sending another start.
- `69b5faf` persists the engine's first Run ID with an acknowledged handoff. A read-only gate checks the exact Task/Run, active control state, trusted engine facts, accepted reference and first Run ID. It grants no effect authority and is not wired into a production Worker.
- `4160f26` stores a fresh 128-bit attempt ID with the one start reservation and requires the immutable Temporal start input to match before acknowledgement. Historical NULL attempts remain unresolved. Independent review also bound the fixed reference Worker's first control activity to the stored attempt before model/tool work.
- On `4160f26`: 258 owned PostgreSQL/HTTP control tests, 48 focused dispatcher/Temporal tests, 14 offline reference tests, five real Temporal handoff cases and one recovery case passed. The wrong-attempt collision made zero model/tool calls; recovery made one synthetic external write and one lookup. `npm run check` passed; 29/31 Turbo lint/typecheck/test tasks and 18/18 build tasks hit cache, while repository prerequisites ran. Details: `docs/research/work-temporal-journey.md` and issue #91.
- `8df7c89` derives activity identity from the actual Temporal SDK context and the immutable start of that exact engine Run, then requires the stored attempt and chain under a read-only PostgreSQL gate. It grants no effect authority and is not wired into a production Worker. The owned PostgreSQL/HTTP suite passed 274 checks with one optional-SDK skip; the same fixture passed 32 SDK adapter checks with the pinned interpreter. An actual local Temporal activity resolved its current Run and immutable start. `npm run check` passed; Turbo lint/test/build tasks were cached while repository prerequisites ran.
- `3ece362` corrects the control claim ID to include the real SDK Activity ID as well as engine Run ID. A retry of the same live activity reuses its fence; the next generated activity in that Run advances the epoch, while an expired/reused ID stays closed. The public read-only binding still reads its own SDK context; one private helper shares a single snapshot with the claim boundary. A real Temporal probe verified retry/next-activity IDs. The owned PostgreSQL/HTTP fixture passed 274 checks with one optional-SDK skip; the same fixture passed 63 pinned-SDK activity/claim checks, including cancel/revoke races. `npm run check` passed with Turbo tasks cached. No production Worker or external-effect authorization is wired yet.
- S2 template/artifact saving has Web/Desktop shell adapters (`877b439`, `b2de930`), but full parity is open. Direct in-workflow tool-port use fails closed (`b0db90d`).

## Open and invariants

- Production Worker/Runtime composition, granular checkpoints, approvals, external-result reconciliation, multi-Run continuation and crash recovery remain unqualified. `experiments/work-journey/` is a reference, not production dispatch.
- S2 parity, S4/TASK020 real Linux/runsc and remaining review findings, and S5–S7 remain open. `experiments/linux-execution/` is an untracked candidate, not accepted product code.
- Python control owns identity, authorization, Task/Action facts, approvals, budgets and artifacts; Temporal owns durable continuation. Runtime/Worker create no authority. Unknown external writes require authoritative lookup or remain unknown. Cancellation/revocation cannot reopen effects. No production cutover or release before these gates pass.
- Preserve unrelated dirty model-service files, `docs/OPEN_SOURCE_REUSE.md`, `docs/research/python-model-services.md` and the untracked TASK020 candidate.

## Next input

Read the last section of `docs/research/work-temporal-journey.md`, `apps/server-python/src/openbot_server/{work_dispatcher.py,work_handoff.py,temporal_engine.py,work_engine_binding.py,work_temporal_activity.py}`, `apps/agent-runtime-python/src/openbot_agent_runtime/{executor.py,sdk_ports.py}` and `experiments/work-journey/workflow_worker.py`. Compose a per-Run production Worker with control-owned authority and separately verified external effects; prove multi-Run and crash recovery before activation. Do not wrap an effectful Run in one retryable activity.
