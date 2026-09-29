# ADR-0020: Make upstream research a feature gate

- Status: Accepted
- Date: 2026-09-04

## Context

OpenBot integrates computer control, agent runtimes, identity, portable skills, and security policy.
Implementing familiar infrastructure locally increases maintenance and security risk, while copying
a popular repository without checking its license or authority model creates a different class of
risk. The project already kept an open-source reuse ledger, but the rule was not yet a repository
instruction for coding agents or a mechanically checked pull-request contract.

The same rule must also apply when old code is expanded. A new feature cannot use an earlier local
implementation as permission to skip upstream review.

## Upstream review

- [Rust RFC template `f17e8623`](https://github.com/rust-lang/rfcs/blob/f17e8623ee2e2854570dcdb936a9f4ab08c0fcd4/0000-template.md)
  (Apache-2.0/MIT repository) requires motivation, alternatives, drawbacks, prior art, and unresolved
  questions before a language design is accepted.
- [Kubernetes KEP template `6ab9bf71`](https://github.com/kubernetes/enhancements/blob/6ab9bf717d1228928740bdbfe761b6e62b870902/keps/NNNN-kep-template/README.md)
  (Apache-2.0) adds test, graduation, upgrade/downgrade, version-skew, monitoring, dependency, and
  implementation-history evidence for non-trivial changes.
- [OpenSSF Scorecard workflow `54d8e4d3`](https://github.com/ossf/scorecard-action/blob/54d8e4d3c579f74e35c422a0a18e16bb58ad9426/.github/workflows/scorecards.yml)
  (Apache-2.0) demonstrates read-only default permissions and full-commit GitHub Action pins.
- [actions/checkout `11d5960a`](https://github.com/actions/checkout/tree/11d5960a326750d5838078e36cf38b85af677262)
  and [actions/setup-node `49933ea5`](https://github.com/actions/setup-node/tree/49933ea5288caeca8642d1e84afbd3f7d6820020)
  (MIT) are the exact existing CI actions reviewed and pinned by this change.

The complete upstream templates are deliberately not copied. OpenBot adapts only the fields needed
for its smaller project and trust boundaries.

## Reuse decision

Adopt the RFC/KEP pattern of checked-in prior-art, alternatives, test, compatibility, and lifecycle
evidence. Keep a smaller OpenBot research record because importing Kubernetes enhancement tooling
would create a second issue lifecycle and does not enforce license or Server-authority review.

Use repository-local Node.js checks and GitHub's existing event payload instead of adding another
workflow dependency. Pin the two existing GitHub Actions by commit following Scorecard guidance.

## Source incorporation

No upstream source or template text was copied or substantially adapted. The OpenBot templates and
validation script were written for this repository; the upstream design lineage remains linked in
this ADR and the reuse ledger.

## Verification plan

- `scripts/check-docs.ts` verifies that the policy and templates retain their required sections.
- `scripts/check-pr-research.ts` rejects a pull request whose research fields are absent, empty, or
  still contain template placeholders; Node's built-in test runner covers accepted and rejected
  bodies.
- `npm run check` runs both gates before lint, typecheck, product tests, and build.
- Reviewers still assess candidate quality, license correctness, source incorporation, and whether
  the claimed local gap is real; syntax checks cannot make those judgments.

## Decision

1. Every behavior-changing requirement needs GitHub and primary-source research before code.
2. The evidence lives in an issue, ADR, or `docs/research` record and pins versions and licenses.
3. Implementation follows the reuse order documented in `docs/OPEN_SOURCE_REUSE.md`.
4. Expansion of existing code first checks the retroactive reuse ledger and closes any partial
   review that affects the proposed change.
5. Pull requests must link the research artifact and report selection, gap, source incorporation,
   verification, and fail-closed behavior.
6. Pure spelling, translation, and mechanical formatting changes are exempt when behavior and
   claims do not change.

## Consequences

- Contributors and coding agents receive the same repository-level instruction.
- Review evidence stays linkable and can be improved independently of an implementation.
- Low-information pull requests fail early, while substantive judgment remains human-owned.
- Feature intake takes longer, but dependency, attribution, compatibility, and lifecycle decisions
  become visible before code is expensive to replace.
