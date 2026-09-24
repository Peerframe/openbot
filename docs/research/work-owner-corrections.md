# Durable Owner corrections in product work

Implementation gate, parent `135df6d`, 2026-09-24. No default switch or release.

## Reuse and reviewed evidence

Reuse Pydantic AI2.47.0 (`77d5fce751ab8ab04bd5db4ed6acc1131a4baed6`, MIT), Temporal Python1.33.0 (`ab52fdde33ee8ed193402625bfdba25d240a762d`, MIT), PostgreSQL17.11 Task-row locks and existing Action/receipt/completion services. Prior release/source/tests/license/security reviews remain in work-deferred-approval.md and work-product-worker.md. No dependency or upstream source copy. Searches checked GitHub pydantic-ai message history/Temporal dynamic instructions and official Temporal versioning docs on 2026-09-24.

Sources: https://pydantic.dev/docs/ai/core-concepts/message-history/ ; https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/ ; https://github.com/pydantic/pydantic-ai/issues/4000 ; https://docs.temporal.io/develop/python/workflows/versioning . The pinned GitHub TemporalAgent source page could not be fetched; inspect installed pinned source instead. Dynamic instruction database I/O cannot run inside Workflow replay. Use separate Activities plus the existing SDK full-message history and cumulative usage. Do not implement another agent loop or retry scheduler.

The OpenBot-specific gap is durable Owner-command/segment identity plus atomic comparison with effect admission and final publication. SDK history alone does not own authorization. Small additive control schema holds bounded instructions/frozen contexts and a distinct never-admitted superseded state; never rewrite old migrations or disguise superseding as verified non-application.

## Frozen boundary before implementation

- Explicit opt-in correction-capable product profile; old persisted load-task results follow the old Workflow sequence. Public correction commands refuse old/unsupported Runs. New profile admits model plus deferred tools only; a configured inline executor is rejected before correction support is enabled. Existing inline-capable profile remains unchanged until its equivalent segment recovery is separately qualified.
- Authenticated same-origin Owner input: original request key, exact Run, expected sequence, at most8 instructions, each at most4096 UTF-8 bytes. Task lock serializes idempotency, cancel/revoke, approvals, correction generation and publication. A correction grants no tools or budget.
- Server freezes immutable instruction context per exact accepted Activity operation; retry reads that context, not current instructions. Context IDs are correlation only and are scoped to Task/Run. Worker identity must still bind the original engine start. Task lock compares the context on every new proposal/admission. Already-admitted operations may return their original durable receipts despite later corrections.
- Supersede only proposed, never-admitted Actions; retain intent/old approval, add explicit superseded provenance. Admitted/unknown never becomes superseded, successful or refunded. Deferred call results pair every original correlation before a corrected SDK continuation. Unknown continues to wait for existing lookup reconciliation.
- Corrected model Activities preserve the original context and request on retry. The new context enters a genuinely new model turn. The correction profile has no inline side effects, so interrupting a stale model segment cannot replay an internal external write.
- Publication and ACK readback bind the exact frozen context; both pre-blob and post-blob gates reject later instructions. The trusted verifier sees that context. A stale result is provisional and triggers another bounded SDK turn with preserved history/usage, not Task completion. Frozen/consumed does not prove semantic obedience; independent result verification remains necessary.

## Ownership and validation

Codex main owns Worker/Runtime routing, model/effect seams, public route and real journey. A single bounded control implementer owns the additive schema, correction store, generic store/completion gates and their database tests; no overlapping files. A different read-only reviewer checks final integration. Preserve unrelated model-service dependencies/research and unaccepted TASK020.

First inspect/test actual app registration, origin/auth, body size and command handling. Then run owned PostgreSQL races, followed by a frozen real HTTP/PG/mTLS correction/restart journey and affected old-profile replay. Test old approval invalidation, late proposal, model receipt retry, frozen-context ACK loss, correction during verification/blob I/O and cancellation. Requalify the new target schema against the two sealed old histories; do not alter those histories. Logs are unique, failed runs retained, cached/skipped checks identified. No real account, production migration or Linux isolation claim.

## Candidate acceptance — 2026-09-24

Parent `135df6d4a67ed7903673f3aa23b9e5c6ab75da26`, with the uncommitted correction slice.
The final journey used `/private/tmp/openbot-corrections-candidate-20260924-03.json`, containing
SHA256 for33 changed/new files; no product/fixture input changed during that execution. Later
Biome changes to `work-api.test.ts` and `test-python-control.mjs` were formatting only; CI and
bilingual instructions were added separately. Existing model-service dependency edits/research,
the earlier reuse-ledger entry and unaccepted TASK020 were retained, not credited to this slice.

The independent reader accepted this opt-in API/Worker slice after checking source hashes, the
actual journey record and the fault-point assertions. Root implemented runtime/HTTP/fixtures;
a separate implementer owned correction storage/schema/tests. The independent reader did not
implement either scope. This is not S3 completion or a backend cutover.

### Executed gates

| Gate | Actual result and existing log |
| --- | --- |
| Actual app entry | Route/middleware/Owner/origin/schema/body/read-only mode passed; final focused suite also accepts the fully escaped4096-byte instruction. `openbot-corrections-entry-20260924-02.log`, then `openbot-corrections-unit-20260924-02.log` in `/private/tmp`. |
| PostgreSQL | `OPENBOT_TEMPORAL_TEST_PYTHON=/private/tmp/openbot-product-profile-20260924/venv/bin/python node scripts/test-python-control.mjs` passed:321 base checks including19 new correction cases;2 optional-SDK files skipped in the base environment. The explicit pinned SDK lane executed157 checks successfully. Log `openbot-corrections-pg-20260924-02.log`. Covers Task locks, same-key replay, late proposals, approval/correction races, unknown reservation, cancellation, context integrity and both publication gates. |
| Focused Workflow/ports |33 checks passed, including old deferred sequence and inline configuration drift; after removing redundant JSON-in-prompt encoding,4 correction checks passed including worst escaped input with retained history. Logs `openbot-corrections-unit-20260924-02.log`, `openbot-corrections-prompt-20260924-01.log`. These are local substitutes, not engine evidence. |
| Real correction journey | `/private/tmp/openbot-model-port-review/venv/bin/python -B experiments/work-journey/probe.py --engine postgres-mtls --only-case product-owner-corrections` passed and exited0. Log `openbot-corrections-journey-20260924-04.log`. SDK versions independently checked: Pydantic AI2.47.0, Temporal1.33.0. |
| Web parser | Superseded proposal remains unspent/without evidence; existing Web test script executed376 checks, including this new test. Log `openbot-corrections-web-20260924-01.log`. This is parser/regression evidence, not a correction UI or installed Desktop test. |
| Synthetic migration/restore | Final35-entry target passed both sealed histories and40 existing checks; source SQL unchanged. Final0034 hash `74418c22fdbd0dd8e0e28ef5ceacfb64fbd47c34f85816bafe1b39eba0aece63`; journal `a75feb5339e5b06bd96fa543e39d964d20922a2f13de5c9853b861cb14fff10c`. See S7 qualification record for exact manifests and pre-fix/final separation. |
| Repository check | `npm run check` exited0, log `openbot-corrections-check-20260924-01.log`. Repository prerequisites executed; Turbo lint/typecheck/test31 tasks succeeded with27 cache hits; build18 succeeded with16 cache hits. Existing skipped native/platform cases and SDK/Vite warnings remain visible in the logs. Cached output is not claimed as fresh execution. |

The actual correction journey proves these distinct reachable paths: a model request rejected
before admission crosses the real RuntimeFailure/CorrectionsChanged cause chain with zero
provider calls; its next original receipt survives correction and Worker death without repeat
billing; preparation interrupted after two durable proposals pairs both superseded proposals and
the never-prepared call; an applied read and unknown write retain facts while a later approved
proposal is superseded. The unknown execute Activity is acknowledged before death, so the actual
Owner reconcile Activity/command must resolve it. A correction during result verification forces
a new SDK segment. Publication death is injected only while its exact Activity is STARTED,
attempt1, without a prior failure; the same Activity later retries, reading committed output with
callbacks disabled. All three original engine Run IDs and offline replay remain unchanged.

### Failures retained and corrections made

- Initial PG run `openbot-corrections-pg-20260924-01.log`: old single-argument publication test
  substitute raised TypeError after the new optional argument was passed positionally. Preserve
  the old invocation shape when no correction token exists; the existing assertion was not weakened.
  That first runner also did not list the new correction file. It was added before the final run.
- Independent input review reproduced8 valid4096-byte quoted instructions exceeding64KiB after
  serialization. The frozen bound is now256KiB; single request body32KiB; closed-field command
  hashing no longer inherits the unrelated16KiB action-intent limit. PG counterexamples include
  both double quotes and six-fold escaping. Raw prompt sections avoid an unnecessary second JSON
  encoding layer. The existing256KiB total SDK history limit still applies; command persistence
  is not a promise that an arbitrarily long conversation or unavailable budget can continue.
- Journey log01 failed at import: the minimal product-only test environment lacked the preexisting
  harness `dbos` dependency. Reused the already-installed full journey environment after version
  checks; no dependency was added.
- Journey log02 failed compiling a fixture assignment expression; log03 failed importing Runtime
  from the new fixture. Both are agent/test-setup failures, not system recovery events. Corrected
  the expression/source path, then fully compiled and imported both modules under the actual
  interpreter before log04. Product inputs did not change for these fixture repairs.
- Before long execution, independent review corrected the publication fault timing and added
  exact unknown-Activity acknowledgement/command-result assertions. No weak assertion was used
  to turn a normal retry into recovery evidence. Formatter findings were fixed only in two touched
  files. All failed logs remain separate.

No real model account, arbitrary website, Linux/runsc isolation, deployment activation, production
migration, remote push or release was tested or performed. Added CI wiring is prepared locally;
remote GitHub CI has not run. The earlier approved staged migration direction remains unchanged.

The affected original profile also passed on the same product bytes:
`/private/tmp/openbot-model-port-review/venv/bin/python -B experiments/work-journey/probe.py --engine postgres-mtls --only-case product-deferred-approval`, exit0;
`/private/tmp/openbot-corrections-old-profile-20260924-01.log`. Approval while absent, disabled
planner after restart, unknown lookup command, cancellation, denial ACK recovery and unchanged
replay passed. These are newly generated original-profile histories; earlier deleted temporary
histories are not claimed to have been replayed. Adding the optional deps field is backward
compatible decoding, not a claim that every serialized SDK payload is byte-for-byte identical.
