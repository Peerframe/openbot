# Research: official SDK durability composition

- Date: 2026-09-23
- Status: eight cases independently pass; Temporal selected for the next reference journey only
- Owner: Codex (TASK019 was never dispatched to WorkBuddy; its proposed source review is superseded)
- Scope: compare released granular SDK adapters with process-separated deferred continuation.

## Evidence and pins

Reuse the existing runtime, DBOS and Temporal reviews. Read installed sources for
`pydantic-ai-slim==2.47.0`, commit `77d5fce751ab8ab04bd5db4ed6acc1131a4baed6` (MIT):
`durable_exec/dbos/{_durability,_operation_backend,_utils}.py`,
`durable_exec/temporal/{__init__,_durability}.py` and the already reviewed deferred API.
Compare DBOS3.0.0 `dd8a5f315a54c02a750f80dd15127958243ed339` and Temporal Python1.33.0
`ab52fdde33ee8ed193402625bfdba25d240a762d` (both MIT). Existing engine reviews cover their
release tests, recovery implementation and license; no new fork or source copying is proposed.
The same CPython3.12.13/POSIX and disposable PostgreSQL17.11 reference is used.
Temporal CLI1.9.1 / Server1.32.0 remains development SQLite, not production persistence parity.

Official documentation read:
[DBOS integration](https://pydantic.dev/docs/ai/capabilities/durable_execution/dbos/),
[Temporal integration](https://pydantic.dev/docs/ai/capabilities/durable_execution/temporal/).
The current docs may have advanced beyond the pin; installed pinned code decides the experiment.
GitHub issue searches examined [7197](https://github.com/pydantic/pydantic-ai/issues/7197)
(agent-level cancellation, open) and [6911](https://github.com/pydantic/pydantic-ai/issues/6911)
(override can remove durability, open). Neither is proof that all workflow cancellation/replay fails.
The direct raw test-page fetch failed; do not claim new upstream test execution from that fetch.

## Integration comparison

| Boundary | DBOSDurability | TemporalDurability |
| --- | --- | --- |
| Loop | SDK loop inside a DBOS workflow; model requests are separate steps | SDK loop inside workflow; model requests are separate activities |
| Ordinary function tools | Inline unless explicitly decorated; cannot assume a completed body is checkpointed | Activity wrapping by default; tool metadata can opt out only under documented constraints |
| Deferred external tools | Return proposals; workflow can persistently wait and supply trusted results | Same SDK seam with durable signals/waits |
| Credentials and authority | Must remain in control adapters; checkpoint replay does not recheck current grants by itself | Same; activity completion is not domain success |
| History format | SDK passes typed objects through default native step serialization; DBOS default is pickle | Official Pydantic-aware payload converter; still needs bounds/provenance/access control |
| Process separation | Adapter assumes SDK and workflow share context; it does not automatically span the current Runtime stdin/stdout protocol | Same workflow-context limitation; model/tool I/O can be separate activities |

The previous standalone continuation probe remains viable when the SDK process ends before a
wait. Do not write a new SDK graph serializer or stack another retry engine. Direct durability is
a candidate for a trusted workflow-side strategy module; it is not permission to move credentials,
DB access or final-state authority into models or execute untrusted code beside them. A separately
supervised strategy process needs a qualified bridge or official deferred results. Independent
Runtime ownership/testing does not itself require a new network service.

DBOS native pickle is acceptable only for this isolated trusted fixture, not an accepted product
checkpoint format. The official adapter's StepConfig exposes retry fields, not a portable codec. A first attempted
portable negative control did not error: it reached deferral and waited, so expecting process
exit was incorrect. The revised experiment measures both workflow and model-step serialization
in the actual DBOS history; do not infer step format from the workflow decorator alone.
Qualify actual stored serialization before selecting direct integration; retaining compatible
execution environments or explicit history migration is required across upgrades, not task deletion.
SDK request counters exclude lost uncommitted attempts and external billing; they do not replace
control-owned shared reservations. Engine cancellation never supplies business revocation.

## Executable decision test

Use a separate pinned environment, not either product venv. A scripted SDK model requests an
ordinary read, then proposes an external write, then consumes its trusted result. Parent-controlled
SIGKILL between completed read and next model result measures DBOS inline vs decorated tools and
Temporal automatic activity wrapping. Independently count model requests and tools in a loopback
fixture; the same completed workflow ID must not add effects. Kill during deferred wait and deliver
approval while no worker exists; recheck current fixture authority before writes. A revoked case
must end without write/final model execution. Inspect actual engine serialization/history.
No real accounts, providers, user database, product dispatcher or executor isolation are involved.
This comparison does not by itself prove production selection or the public Task journey.


## Observations and integration decision

The final combined command passed all eight cases on 2026-09-23. DBOS ordinary-function negative
control executed the read twice; explicit decoration and Temporal automatic activity wrapping
executed it once. Both restored deferred SDK messages after worker death, accepted the decision
while no worker existed and avoided new writes/final requests after fixture revocation. Completed
workflow identities added no model/tool effects. SDK segment run IDs changed on deferred resume.

The killed in-flight model request was observed twice, so the parent counted four attempts while
SDK usage counted three completed requests. Do not translate that usage counter into recovered
billing or shared budget truth. The approval signal/message remains a simplified fixture decision;
no exact public Action approval, grant fencing or concurrent revocation was established here.

Actual DBOS rows confirmed the portable workflow used `portable_json` while SDK request steps
still used `py_pickle`. Thus the initially expected portable serialization exception was wrong:
changing the outer workflow format did not change those steps. Temporal activity-result payloads
were exactly `json/plain` and `binary/null`; no broader claim about all history inputs is made.
The first Temporal assertion omitted the valid null encoding; correcting it did not relax model,
tool, revocation or reuse assertions. A stale `instrument` constructor argument was also removed
before any successful experiment; the pinned SDK API owns that behavior.

Independent review identified that a waiting file precedes its step/activity checkpoint. The final
probe additionally checks DBOS's committed waiting step and Temporal's queried waiting state. DBOS
still proves the durable deferral boundary, not an instrumented point within its `recv` call.
No upstream source was copied or patched; only released adapters and existing owned fixtures run.

**Next reference: TemporalDurability + PydanticAIPlugin with a trusted workflow-side strategy.**
Its released function-tool activity and typed payload integration reduce the adapter surface for
this specific composition. This is an executable path selection, not proof that Temporal is the
best production engine or DBOS is unsuitable. DBOS with official deferred/JSON Runtime segments
remains viable; no graph serializer, custom retry engine or premature dependency switch is added.

Next implement one public Task -> admission/enqueue -> SDK proposal -> exact Action approval ->
external write -> lost-result reconciliation -> verified Artifact -> public reconnect journey.
Use the existing control store for authorization, reservations, epochs, domain outcomes and final
publication. Replayed history can supply confirmed facts, never cached positive grants. Test the
commit/enqueue gap and query the fake external service after a lost response; merely ending with
an unknown result is insufficient. Model/tool ports must stay control-owned and waits must not
require a separate strategy process to remain alive. The existing stdin/stdout Runtime is not
implicitly integrated by this choice; the reference uses a trusted strategy module in a workflow.
Production PostgreSQL persistence, history/code upgrades and restore, true network partition,
stale-worker effect-boundary fencing, resource measurements and Linux isolation remain gates.

Repository `npm run check` and the final documentation check pass. No product dependencies or
default execution selection changed; existing uncommitted model-service work remains excluded.
