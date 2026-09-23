# Architecture migration handoff — 2026-09-24

Current branch: `codex/architecture-migration`; latest verified code `877b439` (S3 baseline `9ccaff5`). Start with this note and the files below; reopen older logs only for a specific failure.

## Completed in this stage

- ADR 0046 selects Temporal as the **target** recovery owner. The production switch is not active. The existing closed-history, lookup-only repair reference is at `6e7cffd`.
- `9ccaff5` records a submission attempt before the first Temporal start request. Repeated notification inspects the original history and never grants a second start. An unconfirmed Task/Run is queried directly, even with a backlog; missing history remains unresolved. The affected control suite (189), reference suite (61), and four public HTTP/PostgreSQL/development-Temporal handoff cases passed. The PostgreSQL/mTLS handoff and recovery cases passed before the final exact-lookup change; they were not rerun for that local read change. `npm run check` passed with Turbo cache hits.
- `877b439` moves employee-template save selection to a Web/Desktop shell adapter. The shared API fetches and verifies bytes without a Desktop bridge or DOM save. The affected 28 tests, Web typecheck and `npm run check` passed; this does not establish full S2 client parity.
- TASK028's bounded-output candidate is in the local, untracked `experiments/linux-execution/`. Independent review corrected incomplete CLI-pipe capture and uncertain image inspection. `python3 -m unittest test_sandbox` actually ran in that directory: 133 passed. `sandbox.py` SHA-256 `0815cb3fb4329e04522eaf9f054d973fbfe38b5335dd37bb1c1cf3a7ede8b5c5`; `test_sandbox.py` SHA-256 `a840a2153e90dadf534fcba808c0035241811d5d261f6536681c6937fea9a314`.

## Open

- S3: production Temporal dispatch, real Python Runtime composition at granular checkpoints, approval/reconciliation operations and recovery qualification. The fixed CSV workflow in `experiments/work-journey/` is a reference, not a production dispatcher.
- S4/TASK020: real Docker log behavior, Linux/runsc isolation and remaining review findings. The fake suite does not accept TASK020 or authorize real effects.
- S2 client/API parity and S5–S7 remain open. Preserve unrelated dirty model-dependency files and the untracked TASK020 candidate; do not merge either into main as accepted product code.
- S3 Runtime composition needs durable model/tool checkpoints. Do not wrap the existing one-shot `BoundedExecutor` as a retryable activity: its whole run can contain external tool effects. Next inspect `apps/agent-runtime-python/src/openbot_agent_runtime/{executor.py,sdk_ports.py}` and `experiments/work-journey/workflow_worker.py` for the narrow integration seam.

## Invariants and next inputs

Python control owns identity, authorization, Task/Action facts, approvals, budgets and artifacts. Temporal alone owns durable continuation; Runtime and Worker gain no authority. Unknown external writes require authoritative lookup or remain unknown. No blind retry, second writer, production cutover or release before their gates.

Next S3 inputs: `docs/decisions/0046-temporal-as-recovery-owner.md`, `apps/server-python/src/openbot_server/work_handoff.py`, `apps/agent-runtime-python/src/openbot_agent_runtime/executor.py`, and `experiments/work-journey/{dispatch.py,workflow_worker.py}`. Use only the relevant test and failure excerpt for the chosen change.
