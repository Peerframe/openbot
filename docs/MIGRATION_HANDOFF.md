# Architecture migration handoff — 2026-09-24

Branch: `codex/architecture-migration`. Current S3 chain-binding code: `69b5faf`. Earlier S3 transport: `153f714`; S2 shell boundary: `b2de930`. Start with this handoff and current code; read older logs only for a specific failure.

## Completed

- ADR 0046 selects Temporal as the target recovery owner; production remains unchanged. Dispatch durably reserves before the first start and inspects original history on redelivery without sending another start.
- `69b5faf` persists the engine's first Run ID with an acknowledged handoff. A read-only gate checks the exact Task/Run, active control state, trusted engine facts, accepted reference and first Run ID. It grants no effect authority and is not wired into a production Worker.
- On that code: 244 owned PostgreSQL/HTTP control tests, 40 focused dispatcher/Temporal tests, two offline dispatcher tests, four real Temporal handoff cases and one recovery case passed. The recovery probe observed one synthetic external write and one lookup. Python check: 840 passed, 245 skipped outside its owned fixture. `npm run check` passed; 29/31 Turbo lint/typecheck/test tasks and 18/18 build tasks hit cache, while repository prerequisites ran. Details: `docs/research/work-temporal-journey.md` and issue #91.
- S2 template/artifact saving has Web/Desktop shell adapters (`877b439`, `b2de930`), but full parity is open. Direct in-workflow tool-port use fails closed (`b0db90d`).

## Open and invariants

- **S3 activation blocker:** an initially unknown submission whose Temporal history expires before acknowledgement still lacks immutable attempt provenance. Bind a durable per-attempt nonce to Temporal start facts, or establish equivalent proof, before production Worker activation. First Run ID protects a chain only after acknowledgement.
- Production Worker/Runtime composition, granular checkpoints, approvals, external-result reconciliation, multi-Run continuation and crash recovery remain unqualified. `experiments/work-journey/` is a reference, not production dispatch.
- S2 parity, S4/TASK020 real Linux/runsc and remaining review findings, and S5–S7 remain open. `experiments/linux-execution/` is an untracked candidate, not accepted product code.
- Python control owns identity, authorization, Task/Action facts, approvals, budgets and artifacts; Temporal owns durable continuation. Runtime/Worker create no authority. Unknown external writes require authoritative lookup or remain unknown. Cancellation/revocation cannot reopen effects. No production cutover or release before these gates pass.
- Preserve unrelated dirty model-service files, `docs/OPEN_SOURCE_REUSE.md`, `docs/research/python-model-services.md` and the untracked TASK020 candidate.

## Next input

Read the last section of `docs/research/work-temporal-journey.md`, `apps/server-python/src/openbot_server/{work_dispatcher.py,work_handoff.py,temporal_engine.py,work_engine_binding.py}` and `experiments/work-journey/workflow_worker.py`. Prove pre-acknowledgement attempt provenance; then compose a per-Run production Worker with control-owned authority and separately verified external effects. Do not wrap an effectful Run in one retryable activity.
