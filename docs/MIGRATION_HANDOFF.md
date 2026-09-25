# Architecture migration handoff — 2026-09-26

## Current checkpoint — product browser capture; CI isolated

- Delivery: the migration draft is [PR #96](https://github.com/Peerframe/openbot/pull/96).
  Product development continues on `codex/browser-product-integration-20260926`, after browser
  identity commit `364d3082f7934605b6f70600704b60bc00a69f82`. The separate CI task owns the PR branch
  `codex/python-migration-draft-20260925` while its hosted checks run. Integrate the product branch
  after that checkpoint; do not overwrite or restart its active CI head. No merge, deployment,
  default-backend switch or installed-app replacement is authorized.
- New product path: an explicit private Bot-to-Node configuration captures immutable browser
  profiles for new channel Tasks. Work approval precedes an observation on the original Worker
  connection. The private PNG becomes an artifact only after verified completion. Models see file
  metadata only. Human takeover/release invalidates prepared captures; reconnect/re-enrollment,
  cancellation and changed source/claim fail closed. Four attempts per Task across corrections;
  acknowledgement recovery only reads original receipts. Missing receipts remain unresolved.
  Default composition is disabled. See [configuration](CONTROLLED_BROWSER.md) and
  [research/validation](research/work-browser-capture.md).
- DeepSeek development: DSH implemented the profile adapter from the public MIT OpenBot command
  profile pattern. Root corrected the SQL event discriminator/order and exact case-sensitive ID
  semantics, then integrated transport, private PNG evidence, result review, startup and tests.
- Evidence: 17 focused browser Work tests and 187 adjacent PostgreSQL/HTTP/WS tests passed;
  30 Node/config tests and `npm run check` passed. One new test runs the actual Node process and
  Docker Provider against an explicitly synthetic loopback computer. Work approval/recovery,
  model receipts, result review and PNG download use real SQL/API transactions; SDK history and
  model responses remain synthetic. See the research record for exact scope and reusable commands.
- Data: canonical migrations now have 44 entries through `0043_work_browser_profiles`, verified on
  a fresh owned database. The earlier paired stopped restore evidence remains pinned to 43 entries:
  46 Control tables/110 rows, 40 history plus 3 visibility tables, 13 paired files, 36 TLS files and
  six wrong-key negatives. It has not been silently relabeled as 44-entry restore qualification.
  Likewise final Desktop packaging and product-container qualification require the new source/schema.
- Retained evidence: the one real Kimi Task used four receipts/8,854 tokens and downloaded a
  231-byte report; do not resubmit it. Native Linux command case2 passed exact CSV, signed receipt,
  original 50-second lifetime and cleanup, with synthetic Control authority. The authorized fixed
  CDP component passed real Linux x86-64/runsc, synthetic DOM/PNG, profile continuity, isolation
  probes and the original 180-second deadline. Do not rerun these accepted cases merely on resume.
- Linux product command remains open: product1 and product2 identities are consumed. Product2's
  fixture parser is fixed to the supported 512-byte class; see the
  [failure record](../experiments/work-journey/evidence/product-command-remote-product2-attempt.json).
  The prepared product3 four-file upload and one 150-second test require their exact authorization.
  No remote test window is active.
- Remaining product gates: browser page interpretation/input/egress and complete handover;
  remote Work→Node→protected Host command acceptance; updated paired restore, final package and
  replacement qualification. A capture-only Task does not establish general browser automation.
  Keep the replaced TS business Server until those gates pass. Preserve the immutable 59-file
  `tests/oracles/legacy-server` test oracle and retained TS Node/Provider/publisher/MCP tooling.
- Ownership: root alone writes this product branch. The CI task alone repairs and verifies the
  draft's CI branch. Six earlier CI/Preview handoff files may still be dirty in the original
  checkout as recovery copies; do not include them in the product commit. Preserve existing user
  data/configuration, the retained migration PostgreSQL fixture and accepted evidence. Clean only
  the new owned capture fixture after validation; never purge shared Docker cache.
- Architecture: the Owner-confirmed 2026-09-24 design review v2 remains the reference. Server owns
  identity/permissions and Temporal owns continuation. Whole-repository package rearrangement,
  visual-system work and marketplaces remain later work. Root product work must not become a
  second CI repair task.

The stage notes below are historical evidence, not the current work order.

## Resumed parallel work — baseline `6f69be9`

Latest user approval resumes S3 and bounded S2/S4/S5 parallel work; S6/S7 receive no new assignments. S2 thread `01a0d28c-f457-7823-ba6f-f144adf3c3ff` delivered and returned ownership. Existing S4/S5 also delivered; S4 remains separate, S5 is integrated. No default switch or release. The older pause paragraphs below are historical.


## Previous short handoff — accepted parallel increments (code `a61153e`)

- Completed: S3 `76667ea` closes original-Workflow unknown reconciliation without renewed writes or authority. S2 `ef1e254` + `a61153e` adds the real `#/tasks` create/read/cancel client and closes both independent offline/413 counterexamples. S5 `ace87c8` integrates only the reviewed offline selection/revalidation port.
- Evidence: S3 actual HTTP/PG/mTLS recovery and affected approval replay passed on frozen source; S2 original32 plus independent4 counterexamples and author real browser/PG evidence passed. Integrated S2 files matched `dfa40d4`; S5 files matched `df1c24d` and its15 new tests passed in the mainline. Final combined entry/check results are recorded in S2 research.
- Open: S3 execution-time corrections and trusted service activation; S2 approval/repair/download and installed Desktop; S4 real positive Linux/runsc, browser/takeover and safe output provisioning; S5 authoritative product readers/use gates. S6/S7 preparation does not close those stages.
- S4 `bb37d57`: independent155 checks accept refusing unverified mounts only. The candidate stays in `<isolated-s4-worktree>`; do not overwrite or accept the retained untracked mainline TASK020 directory.
- Next input: this handoff, `work_worker.py`, `work_closed_repair.py`, S2 `WorkTasksScreen.tsx`, S5 `SELECTION_PORT.md`, and their focused research records. Preserve model-service dirty files, `docs/OPEN_SOURCE_REUSE.md`'s earlier entry and TASK020. One implementer per scope; Server owns authority, Temporal owns continuation, unknown permits lookup only. No push, cutover or release.


## Previous short handoff — closed-workflow lookup (parent `6f69be9`)

- Completed: explicit `--repair-closed` delivery and same-Worker lookup-only repair of a stored deferred Action after its original Workflow closes. Bad evidence stays unknown/reserved; later cycles do not rewrite an old unresolved command. Commit-before-ack retries do not call lookup again.
- Evidence: independent review, frozen-source public HTTP/PG/mTLS closed-repair journey and affected deferred-approval recovery passed; entry, owned database and repository checks passed. Executed/cache/skip details and hashes: `docs/research/work-closed-repair.md`.
- Open: S3 product corrections and trusted deployment/service activation remain. S2 `0a9fc21` requires two independently reproduced fixes (late response after offline; explicit 413 rejection); the original implementer owns the correction. S5 `df1c24d` independently accepted offline-only and integrated as `ace87c8` (identical bytes; focused tests rerun). S4 `bb37d57` accepted only for refusing unverified output mounts; keep the candidate separate, with no runsc/real lifecycle acceptance or TASK020 closure.
- Next input: this handoff, `work_closed_repair.py`, `work_repair_binding.py`, `work_repair_dispatch.py`, `work_worker.py` and the research above. Preserve unrelated model-service edits and TASK020. Original authority and unknown-effect rules remain; no default switch or release.


## Previous short handoff — deferred approval (parent `965a643`)

- Completed: product deferred proposal/approval uses the original durable Action after restart; unknown outcomes permit lookup-only Owner commands, then full-history/cumulative-usage continuation. Denial closes the Task and recovers a lost acknowledgement without new authority.
- Evidence: actual public HTTP/PG/mTLS prepare/deny acknowledgement loss, approval while absent, cancellation, unknown repair, download and unchanged replay passed. Independent review preceded the long test; exact candidate hashes, failure logs and executed/cached/skipped checks are in `docs/research/work-deferred-approval.md`.
- Open: this slice does not complete S3. Product corrections, general service activation and closed-Workflow repair integration remain; S4 Linux/runsc and TASK020 are unaccepted. No default change or release.
- Stop: the latest user instruction supersedes the earlier through-S4 stop point. Finish this slice's local delivery, then pause; do not start another S3/S4 task. Future input, only after authorization: this handoff, the local delivery commit, `work_deferred.py`, `work_worker.py` and the new research file. Preserve unrelated model-service edits and TASK020.


## Current short handoff — product Worker/dispatch (parent `d0f7c1a`)

- Completed: optional product-owned Workflow/Agent with trusted per-Run services and independent publication verification; finite operator CLI with explicit mTLS. A lost publication acknowledgement reads the exact committed result without new claims, callbacks or effects.
- Evidence: actual public HTTP/PG/mTLS model-receipt recovery, publication recovery through the real CLI, and two concurrent Tasks with isolated cancellation all passed, including file download and unchanged replay. Clean optional dependency install, permission/batch counterexamples, PG corruption/race checks and repository check passed. Exact candidate hashes, failures, commands and cache limits: `docs/research/work-product-worker.md`.
- Open: S3 product service configuration and general approval/correction/continuation; opt-in Worker is not complete S3. S4 actual Linux/runsc, browser/takeover and integration remain unaccepted. Overall remains roughly25%, S3; preparation is not phase completion.
- Next: `work_worker.py`, `work_runtime_ports.py`, `work_dispatch_batch.py`, `scripts/dispatch-work.py`, and product cases in `experiments/work-journey/`. Keep Server authority, one Temporal recovery owner and unknown lookup-only rules. Preserve unrelated dirty model-service files and TASK020. No default switch or release; stop after through-S4 integration is accepted.

## Previous short handoff — durable model observations (`d2b3372`)

- Completed: optional real OpenAI/Pydantic model port and control-private replies tied to admitted Actions. A lost Activity acknowledgement reuses the original response and usage, including after claim expiry. Unknown/missing results are never resent or refunded. Settled replies must match original evidence. Text/functions only; no implicit media downloads or hosted tools.
- Evidence: actual public HTTP/PostgreSQL/mTLS Temporal crash-after-receipt journey, unique settlement, file download and unchanged replay passed; concurrent Task isolation retained. PG corruption/cancel/unknown counterexamples and bounded SDK checks passed. Repository check passed with cache status recorded. Additive SQL0033 requalified against both retained synthetic histories; source histories unchanged. See `docs/research/work-model-ports.md` and S7 evidence. Real SDK uses synthetic HTTP, not a live model account.
- Open: S3 product service configuration/dispatch, general continuation/corrections and publication remain. This port is optional, not a fully activated Worker or S3 completion. S4 still lacks accepted real Linux/runsc, browser/takeover and execution integration. Overall rough estimate remains25%, S3; S5–S7 preparations do not complete their stages.
- Next: `work_model_activity.py`, `work_model_receipts.py`, `work_openai_model.py`, `work_runtime_ports.py`, and `experiments/work-journey/model_recovery_probe.py`. Wire trusted product service selection under the same authority and receipt contract. Preserve one recovery owner, historical facts without new grants, unrelated dirty model-service files and unaccepted TASK020. No default switch/release; stop after through-S4 integration is actually accepted.

## Previous short handoff — shared Worker ports (parent `06f6762`)

- Completed: optional control-owned `WorkRuntimePortFactory` supplies fresh per-activity model/tool ports from accepted Task/Run identity, detached schemas and bounded runtime contracts. Loading services cannot execute effects. Codex fixed independently reproduced revocation/deadline gaps in dsh's handed-back candidate; no Task/Run process cache is introduced.
- Evidence: actual public HTTP/PostgreSQL journeys on development and PostgreSQL/mTLS Temporal use one Worker/Agent/queue for two overlapping Tasks. Cancelling one prevents further effects; the other independently settles usage and downloads its own artifact. Both histories replay without mutations. Focused counterexamples and repository check pass; exact hashes, failures and commands are in the final research section. Cached Turbo checks are distinguished from executed Python/probe checks.
- Open: live product service configuration, generic durable operation identity, continuation/corrections and publication/recovery remain S3 work. The new shared fixture is scripted; it does not complete S3 or prove low-budget rejection. Overall remains roughly25%, S3. S4 reconfirmed no real Linux/runsc acceptance and no supplied Linux x86-64 target VM; do not integrate TASK020 or treat fake tests as isolation proof.
- Next: `work_runtime_ports.py`, `work_temporal_start.py`, `work_temporal_effect.py`, Runtime `temporal_agent.py`, and `experiments/work-journey/multitask_worker.py`. Integrate trusted real service loading and durable operation identities under existing control authority before claiming a general Worker. Preserve unknown lookup-only semantics, revocation, unrelated dirty model-service files and TASK020. No default switch or release; stop after the user-requested through-S4 integration is actually accepted.


## Previous short handoff — Worker startup (parent `1f5f98e`)

- Completed: the control package now supplies a read-only, accepted activity Task/Run context loader. The reference Worker can start before dispatcher acknowledgement: the engine retries only startup within a separate 120-second bound, with no model/tool calls until acceptance. Restart during pending then acknowledgement completes once; cancellation before acknowledgement stays closed after restart. The initial activity name/input/None result and all effect policies are unchanged. dsh implemented the loader/unit candidate; Codex integrated, added actual PostgreSQL/public-entry counterexamples, and independently verified it.
- Evidence: 31 loader unit checks and 79 reference unit checks passed; the owned PostgreSQL/HTTP gate passed 302 checks with 2 optional files skipped. Actual public Worker-before-ack, pending-cancel, five handoff rejection cases and recovery/history replay passed. Research records exact commands, code hashes and logs. `npm run check` passed; repository prerequisites executed, Turbo lanes were cached. The earlier `1f5f98e` PostgreSQL/mTLS adjacent-release acceptance is retained for unchanged engine deployment; it was not rerun or relabeled as this candidate's complete qualification.
- Still open: general product Worker/model/tool composition, stable per-operation identities and whole-Run continuation/corrections; the fixed reference remains scripted. S4 real Linux/runsc is unaccepted, S5–S7 preparations are integrated but not product-complete. Overall remains roughly 25%, S3; no default switch or release.
- Next: `work_temporal_start.py`, `work_temporal_activity.py`, `work_temporal_effect.py`, Runtime `temporal_agent.py`, and `experiments/work-journey/workflow_worker.py`. Replace fixed per-Task Worker configuration with accepted per-Run factories and durable control Actions. Context is never authority; unknown writes permit lookup only, cancellation/revocation cannot reauthorize effects. Preserve unrelated dirty files and TASK020. Read old evidence only for a concrete failure.

## Previous Runtime composition handoff (parent `e07e858`)

- Integrated: the Runtime now owns the opt-in constructor-time Temporal Agent builder. Two concurrent Runs use sync/async factories inside activities; Workflow bootstrap uses inert metadata. Nested retry options are detached from caller mutation. Independent review accepted this boundary; 71 focused checks and actual two-Run histories/replay passed. Integrated `npm run check` passed (repository prerequisites ran, Turbo results cached). Source hashes and failure/final logs: `docs/research/work-temporal-journey.md`, final section.
- Still open: product Worker port loading tied to accepted identity and control-owned Action/budget, corrections/final publication, restart/continuation. S4 real Linux/runsc remains unaccepted; S5–S7 integrated preparations do not complete those stages. Overall remains roughly 25%, S3 in progress. No default switch or release.
- Next: `apps/agent-runtime-python/src/openbot_agent_runtime/temporal_agent.py`, `experiments/work-journey/multirun_port_probe.py`, control `work_temporal_activity.py` / `work_temporal_effect.py`, and ADR0046. Keep Server authority and unknown-effect reconciliation unchanged; no new external write on retry. Preserve unrelated dirty files and the unaccepted TASK020 candidate. Read older evidence only for a specific failure.

## Previous fixed-reference handoff (parent `e176e90`)

- Completed: the fixed reference now exercises the product Activity-to-Action seam in a real Temporal engine. Unknown writes are looked up without another POST; cancellation permits only historical settlement. Repair delivery verifies the persisted attempt and original engine chain. Independent final runs passed 21 focused unit checks and the complete 16-case development-engine journey, including real-history replay. Integrated `npm run check` exited 0; Turbo lanes were cached and repository prerequisites executed. Exact candidate hashes, commands, failures and logs are in the final section of `docs/research/work-temporal-journey.md`.
- Open: product Worker/Runtime composition, stable per-operation Action identity, whole-Run budget and general continuation remain S3 work. This candidate has not run on the PostgreSQL/mTLS engine or adjacent-release lane; the latter's held-publication lookup expectation needs review. Real Linux/runsc and S2 parity remain open. Overall delivery remains roughly 25%, S3 in progress; this reference does not complete the stage.
- Invariants: Python control owns identity, authorization, Task/Action facts, approvals, budget and artifacts; Temporal owns continuation; Runtime/Worker gain no authority. Unknown writes require authoritative lookup or remain unknown. Cancel/revoke cannot reauthorize effects. No production cutover or release.
- Next input: `apps/server-python/src/openbot_server/{work_temporal_activity.py,work_temporal_effect.py,work_effects.py}`, `apps/agent-runtime-python/src/openbot_agent_runtime/{executor.py,sdk_ports.py}`, this commit's `experiments/work-journey/` changes, and the final research section. Preserve unrelated dirty model-service files, `docs/OPEN_SOURCE_REUSE.md` and unaccepted `experiments/linux-execution/`. S4–S7 have separate worktree tasks; their preparation is not product acceptance. Read older notes only for a specific failure.

S6 baseline `1fd8b0d` was independently accepted: synthetic PostgreSQL/MCP grant, cancellation, 401, serialization and per-Run budget checks; see `docs/research/s6-compatibility.md`. C11 was corrected to distinguish the shared deadline from per-Run budgets. Product S6 remains pending.

S7 prerequisite `ea75b92` + cleanup fix `36ddc5d` was independently accepted: sealed source histories, bounded synthetic transfer and real PostgreSQL/file backup restoration. Target SQL remains the 33-entry `e176e90` pin. Dedicated CI is prepared, not yet run; legacy work conversion, full product data and Temporal pairing remain open. See `docs/research/s7-migration-qualification.md`.

S5 offline fixture `5d838b5` was independently accepted: reviewed correction, scoped retrieval, suspension/revocation/deletion and no grant increase. Its deterministic arithmetic result is not live-model learning evidence. S5–S7 preparation is now integrated, while product hooks remain pending S2/S3 contracts. S4/TASK020 remains outside accepted product code. See `docs/research/s5-memory-skills.md`.

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
