# TS control candidate rules

This is the accepted ADR-0050 P2 entry candidate, not the retired Server or an alternate authority.
Read [README](README.md), [adapter evidence](../../docs/research/typescript-control-plane-p0.md#p2-forwarding-adapter-review-2026-10-06)
and the [shared protocol rules](../../packages/protocol/AGENTS.md).

Python remains the session issuer and background owner; Temporal owns
recovery. The explicitly selected P3 `transcription` group owns only its shared-inventory GET and
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
Origin/session preflight precedes bounded JSON; every other request body still forwards unchanged.
No model credentials, automatic retry or fallback. Default/paired reverse remain Python-owned.
