# Product result content review

- Status: pre-implementation decision, 2026-09-25.
- Acceptance: final text and actual Markdown reports are checked against the current Task,
  every Owner correction and all current-generation observed tool content before publication.
- Boundary: deterministic provenance checks plus a separate model quality signal. Neither an
  observed MCP response nor the reviewer proves an external business mutation succeeded.

## Evidence and candidate decision

Reused `docs/OPEN_SOURCE_REUSE.md` entries for durable model observations, tool results and
product Worker, with `docs/research/work-model-ports.md`, `work-tool-results.md` and
`work-product-worker.md`. Read their actual adapters, Action settlement, completion locks,
correction contexts, immutable blob codecs and optional SDK tests before implementation.

Searched GitHub for `pydantic/pydantic-ai v2.47.0 ModelResponse text output structured` and the
MCP official tools specification for `isError annotations untrusted`. Read the maintained
[Pydantic output contract](https://github.com/pydantic/pydantic-ai/blob/main/docs/output.md),
[issue #2793](https://github.com/pydantic/pydantic-ai/issues/2793) and
[MCP tool contract](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/server/tools.mdx).
These corroborate that structured shape is distinct from content correctness, and tool annotations
and returned content are not independently verified business effects.

| Candidate | Pin and license | Decision |
| --- | --- | --- |
| Existing durable model port over Pydantic AI | 2.47.0 / `77d5fce751ab8ab04bd5db4ed6acc1131a4baed6`, MIT | Reuse one `ModelStepRequest`, no tools; strict local JSON verdict parsing, no Agent or retry loop. Existing release/source/tests/security review retained. |
| Existing Temporal Activity binding | Python 1.33.0 / `ab52fdde33ee8ed193402625bfdba25d240a762d`, MIT | Reuse actual SDK Activity identity, same-transaction acceptance and current fence. |
| Existing PostgreSQL / immutable files | PostgreSQL 17.11, PostgreSQL license; OpenBot MIT code | Reuse durable Action, model/tool receipt codecs, source mapping and revision CAS. |
| Additional agent/evaluation framework | None added | Cannot supply authoritative task-specific business-effect proof; unnecessary dependency/retry owner. |

Select the first viable thin adapter. The exact missing local behavior is publication content
review over scoped original receipts, without granting an observed response external-effect
semantics. No new dependency, SQL, transport, source copying or upstream source adaptation.
OpenBot's existing MIT notice is unchanged. Knowledge learning remains inspired by Hermes Agent;
this adapter consumes its reviewed public projection, never the private authority receipt.

## Contract and failure behavior

`ProductWorkResultVerifier.verify(context, summary)` returns a `VerifiedTaskResult` only after:
current actual SDK binding/fence/source membership and root data-permission checks; all required
Actions resolved; exact final text from the latest applied current-generation producer model
receipt; all current tools verified with existing ToolResults; actual report bytes matched to
Control-prepared report observations; and one separate publication-Activity review accepted.

The trusted evidence collector must return all current tool payloads and reports, without private
receipts. The adapter cross-checks these against stored observations. It never lets a collector
add a tool result or change bytes. The root permission gate receives the existing transaction and
must return exactly True. Both callbacks are mandatory and read-only.

The reviewer receives original objective, every correction, exact final text, full bounded public
results and report content. It must reject unsupported assertions, unmet requirements or external
mutation goals lacking independent business-effect evidence. Approved confirm-mode MCP observations may support an observational answer that explicitly
states which external completion remains unverified; read mode retains its no-approval contract.
The reviewer must still reject business-success claims without independent evidence and may not
downgrade the original objective into a weaker report. It is a source-grounded answer/report
review, not a general business-outcome oracle. JSON syntax, denial, timeout, oversized evidence, missing
receipts, unknown Actions, revoked knowledge or unsupported artifacts fail closed; no corrective
retry is added. Provider retries remain disabled in the existing port.

A fixed UTC message timestamp and stable serialized evidence make retry hashes identical.
The current publication Activity owns its own model Action key. Its events alone are excluded
from the bound state fingerprint; every other Control event, Action and receipt is compared before
and after the review. The final exact Task revision is returned only after that comparison and
fresh permission/fence checks, allowing store.complete's existing precise CAS to reject later
changes. Historical response recovery never grants publication authority.

## Validation plan

Actual disposable PostgreSQL and real pinned SDK with synthetic HTTP transport; no live-provider
quality benchmark. Cases include producer spoofing, receipt/blob loss, wrong scope/generation,
all corrections, omitted/altered evidence, report byte changes, MCP errors and writes, strict JSON,
review denial, same-Activity retries with exactly one review call, unknown no-resend, expired fence,
concurrent corrections/cancellation/ordinary revision events, fresh permission refusal and exact
publication revision. Root owns real Temporal/HTTP composition and broad checks.

## Measured implementation evidence

The source-grounded content reviewer is implemented as the bounded adapter above. Final qualification
and exact callback contracts are in RESULT.md. The pinned SDK's SystemPromptPart also generates a
current timestamp by default; retry qualification found this and fixed all request/part timestamps.
The review now binds the non-review revision residue in addition to event/Action fingerprints,
so a concurrent revision-only update cannot be silently accepted. Model receipts are decoded using
the existing ModelReceipts outside Task transactions; the final short transaction checks their
unchanged metadata and reopens the original blobs using LocalWorkFiles hash/size readback.
No nested receipt DB connection or duplicate model codec was introduced.

## Confirmed plugin observations (integration correction)

The initial blanket refusal of every `confirm` plugin receipt exceeded the retained MCP contract.
The existing plugin review and pinned MCP1.29.0 distinguish Owner approval, observation of a tool
response, `isError`, and independent business-effect verification. An approved invocation may be
reported as an observed attempt when that is the Owner's objective. It cannot prove that an external
mutation succeeded, or silently replace a requested verified business outcome with an attempt.
Reuse the existing ToolResults observation and independent content review; no new verifier or
transport is introduced. The reviewer receives explicit plugin mode and `response_observed_only`,
requires the original approval record for confirm mode, and retains every error. It must reject
unsupported success claims or unmet business goals. This remains a fallible content review, not a
deterministic validator of arbitrary natural-language claims. Source was not copied.
