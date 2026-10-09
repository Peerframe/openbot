# ADR-0049: Owner approval policy and exact read exceptions

- Status: Accepted for the bounded C4 contract
- Date: 2026-10-01

## Decision

The Python Server remains the only authority. Reuse trusted Work proposals, durable exact-intent
approvals and effect guards. The Owner may add confirmation to built-in product reads and public
web reads (`product_read`, `public_web`). Default `inherit` retains the current adapter minimum;
`required` adds approval. Exact Bot + target exceptions waive only this added confirmation. They
never waive an adapter minimum, create a grant, enlarge task/source access, refresh an expired
Action, alter receipts, or authorize an unknown tool.

Only built-in `work_reads` channel/attachment reads and `product_web` page reads can match an
exception. Search has no exact target and cannot match. All caller/Provider/plugin labels remain
untrusted; adapters still validate complete immutable intents and live source authority. Targets
are exact channel/attachment UUIDs or canonical HTTPS page URLs without credentials/query/fragment.
No wildcard, host-wide, prefix, file path, shell expression or target list is accepted. Exceptions
require a live Bot and existing channel/attachment at save time; removal/deletion still passes
through existing task/source access checks. Maximum64 exceptions and optimistic revision checks.

Delete, installation and permission changes can **never** accept exceptions. Command execution,
browser capture/input, plugins and unknown operations also have no exception contract: their
existing minimum authority/approval stays in force. This API does not expose a global auto-approve
switch or change direct Owner operation authentication. Only the two listed Work categories are
configurable; protected operations are explicitly reported in the settings response.

Persist strict settings and original adapter approval minima. Propose computes added approval in
the same transaction. Admission and built-in read/web dispatch re-evaluate current settings under
a shared policy-row lock. Policy updates take an exclusive row lock; this serializes against these
short checkpoints and bounded local reads. An unapproved auto Action whose exception disappeared
or category became required is refused with `approval_policy_changed`, including after admission;
it needs a fresh proposal. Already approved Actions keep their exact approval. Relaxation never
rewrites a pending proposal or decision. Applied/unknown receipt reconciliation remains possible
and never starts another effect. A web request already dispatched before a settings commit can
finish; no claim of remote cancellation. Existing dispatch markers prevent replay.

Owner cookies, exact Origin, strict bounded input, revision conflict and atomic audit apply to
settings writes. Missing/corrupt policy storage refuses supported reads rather than defaulting to
permissive behavior. Migrations seed `inherit` without changing legacy decisions. Original SQL
history is never edited; independent C2/C7/C4 migration PRs must rebase/reindex after an earlier one
merges. No UI/design changes, dependency or copied source.

## Research and alternatives

Reuse [the prior policy research](../research/dev-001-short-term-hardening.md) and product Work
approval/read/web contracts pinned to OpenBot `57341154b19d45686b2f71bce96fca38e1f07310`.
Primary searches on 2026-10-01: GitHub Cedar/OPA releases, source/tests/open issues, and official
policy precedence docs. [Cedar4.13.0](https://github.com/cedar-policy/cedar/tree/324d3c09fc94ab91464ec340eb81e4b167deb6f5)
is Apache-2.0, released2026-09-15; Rust core, `cedar-testing`, CLI and WASM, active stack-safe
 evaluator issue2590. [Cedar authorization](https://docs.cedarpolicy.com/auth/authorization.html)
specifies explicit denial precedence. [OPA1.21.1](https://github.com/open-policy-agent/opa/tree/2a109e54103370d2ef288782ef3cb4c8a37902b2)
is Apache-2.0, released2026-09-29; Go evaluator `v1/topdown/*_test.go`, active bundle-signature
issue9300. [OPA integration](https://www.openpolicyagent.org/docs/integration) adds a process or
embedded evaluator; [Rego](https://www.openpolicyagent.org/docs/policy-language) requires an explicit
combining policy and handles undefined/error results. Neither supplies OpenBot's current exact
Work/source/fence binding. A thin existing transaction guard is the smallest complete choice for
two fixed settings; importing an expression engine adds policy distribution/error semantics and
packaging without closing that binding gap. Reopen when editable expressions/tenancy are requested.
No candidate source was copied or adapted; notices remain unchanged.

## Required verification before delivery

Write negative tests before implementation: delete/install/permission exception rejection,
unknown category/target/wildcards, mismatched category, invalid URL/Bot IDs and duplicate targets;
mandatory adapter approvals cannot be removed. Real PostgreSQL/HTTP tests must cover cookie/Origin,
revision/concurrent updates, audit rollback, exact target/Bot matching, tightened policy at admission
and dispatch, relaxation preserving pending proposals, and missing/corrupt storage failure. Existing
Work recovery and product read/web suites remain required. Record actual Worker qualification
separately from control-fixture tests; do not claim an unavailable Worker run.
