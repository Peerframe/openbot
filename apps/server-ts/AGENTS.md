# TS control candidate rules

This is the accepted ADR-0050 P2 entry candidate, not the retired Server or an alternate authority.
Read [README](README.md), [adapter evidence](../../docs/research/typescript-control-plane-p0.md#p2-forwarding-adapter-review-2026-10-06)
and the [shared protocol rules](../../packages/protocol/AGENTS.md).

Python remains the default session issuer and background owner; Temporal owns
recovery. The explicitly selected `owner` auth candidate owns all six auth/session operations,
using the existing credential/session/throttle tables and auth-before-session lock order.
Its retained Python routes refuse while selected; paired reverse keeps the newer SQL facts.
Read the [auth decision](../../docs/research/typescript-control-plane-p0.md#p3-owner-authentication-decision-2026-10-08). The explicitly selected P3 `transcription` group owns only its shared-inventory GET and
validates the existing Owner session inside the same bounded PostgreSQL transaction. Read
[the scoped decision](../../docs/research/typescript-control-plane-p0.md#p3-transcription-read-decision-and-security-review-2026-10-07).
Default forwarding and explicit paired reverse selection remain supported; no automatic fallback. Forward bytes to one explicit private upstream without parsing bodies, retry, reconnect,
fallback or caller-selected destinations. Preserve direct peer throttling, original Origin/cookies,
status/error envelopes, stream backpressure and bounded shutdown. Group ownership must derive from
the shared operation inventory; no TS group is active until its migration gate passes.

Run the real transport tests and mixed disposable contracts from README. Synthetic upstreams prove
transport behavior only; they cannot replace the real Python/SQL/Web/Desktop, execution or native
packaging gates. Keep future group migration out of forwarding fixes and retire the adapter in P5.

The explicitly selected `primary-bot` write candidate owns only shared-inventory PUT primary-Bot
selection. Its Owner transaction commits preference/revision and existing audit together; Python
retains identity creation/import/deletion and automatic preference lifecycle updates with the same
workspace-first locks. Read the [scoped decision](../../docs/research/typescript-control-plane-p0.md#p3-primary-bot-selection-decision-2026-10-08).
Origin/session preflight precedes bounded JSON; unselected operations still forward unchanged.
No model credentials, automatic retry or fallback. Default/paired reverse remain Python-owned.

The selected `identity` product candidate owns the eleven operations listed in `product-identity.ts`
and [its decision](../../docs/research/typescript-control-plane-p0.md#p3-conversation-and-identity-editing-decision-2026-10-08).
Keep Owner SHARE/final-expiry, revision CAS and audit in the same bounded transaction. Its paired
Python quarantine only disables public entry points. Generic product mutations invalidate the sole
Python SSE owner through empty transactional PostgreSQL notifications; typed appearance no-ops stay
silent. Remove that coexistence listener when SSE moves. Bot creation/deletion, member removal,
files, model secrets and task execution are not owned by this cohort. Keep the P3 phase explicitly
incomplete until all remaining groups and their gates finish.


The complete `p3` product selection supersedes the narrower candidate descriptions above; see
[the complete composition](README.md#complete-p3-candidate). TS owns its public product routes and
sole SSE publisher. Retained Python owns P4 Work/Temporal and Worker sockets; never fabricate live
registry data or add a second assignment owner. Its finite private runtime port is inaccessible at
public ingress, carries original authority and revalidates browser dispatch under the shared gate.
Preserve one-use claims, descriptor-relative storage, shared identity locks and no-retry semantics.
The v7 native marker selects `p3`; reverse requires paired process shutdown and the same newer SQL,
keys and plugin state. Exact completion evidence belongs in the existing current candidate receipt;
keep phase completion distinct from approved merge, installed release and P4/P5 completion.
