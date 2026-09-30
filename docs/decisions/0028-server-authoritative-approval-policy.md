# ADR-0028: Recompute approval policy at the Server boundary

- Status: Accepted
- Date: 2026-09-04

## Context

The Node protocol reports that an execution needs approval and includes an action, target, and risk.
The Server previously persisted those claims without evaluating its existing policy package. A
compromised or faulty Node could therefore omit a known approval, invent an action, or label a
destructive operation as an ordinary write. That contradicts the Server-only authority boundary.

This short-term correction cannot make Nodes trustworthy or authorize real side effects. The
protocol still lacks a signed, expiring, single-use capability lease and target revalidation after
approval. Real side-effecting Providers remain disabled pending that design.

## Upstream review

- [CEL specification `v0.25.2` / `cb51b417`](https://github.com/google/cel-spec/tree/cb51b4176013ad19bd00df94be273c322916a620)
  (Apache-2.0) provides a portable, non-Turing-complete expression language and conformance tests.
- [OPA `v1.16.2` / `85f6d990`](https://github.com/open-policy-agent/opa/tree/85f6d990d19094da38e829561813e7da7fbae272)
  (Apache-2.0) provides a mature policy language, engine, bundle lifecycle, tests, and deployment
  modes.
- [Cerbos `v0.46.0`](https://github.com/cerbos/cerbos/tree/v0.46.0) (Apache-2.0) provides an external
  authorization service and policy store.

All three are actively maintained, but OpenBot currently has no editable policy language, signed
bundle distribution, or second policy-service lifecycle. The exact gap is a small static catalog
at the existing Server boundary.

## Reuse decision

Keep the existing `@openbot/policy` evaluator and connect it to the Server. Add only a Server-owned
catalog of supported action/target prefixes and minimum risks. Defer CEL as the preferred future
expression candidate until OpenBot designs editable, versioned, signed policy distribution. Do not
add an OPA or Cerbos authority before it can be operated and reconciled safely.

## Source incorporation

No upstream source or documentation is copied or substantially adapted. The implementation uses
OpenBot's existing local evaluator; upstream engines are comparison evidence only.

## Verification plan

- Dispatcher tests reject unknown action/target pairs before approval persistence.
- Dispatcher tests reject a Node-reported risk below the Server catalog's minimum.
- Positive tests prove persisted risk comes from the Server catalog, not the Node message.
- Existing policy and Run transition tests continue to pass.
- Architecture, API, and security documentation retain the capability-lease limitation.

## Decision

1. The Server evaluates every Node approval request against its own catalog before persisting it.
2. Unknown actions and targets are denied. A `deny` or `allow` result cannot be converted into an
   approval merely because the Node requested one.
3. Every approval rule owns a minimum risk. A Node claim below that floor is a protocol violation
   and fails the Run; an equal or higher claim cannot lower the Server-owned persisted risk.
4. Policy rules are static code in this phase. They are reviewed and versioned with the Server.
5. An Owner decision still sends only a decision notification. It is not a capability lease and
   cannot justify enabling real side-effecting Providers.

## Consequences

- A Node can no longer create an approval record for an unknown operation or choose its stored risk.
- Adding a new actionable Provider operation now requires an explicit Server catalog change and
  tests.
- Static rules are deliberately less flexible than CEL/OPA/Cerbos, but avoid an unaudited second
  authority.
- Approval replay, post-approval target drift, Node omission of an approval request, and lease
  revocation remain unresolved until the capability-lease protocol lands.

## Current implementation — 2026-09-29

This decision records the retired TypeScript Server phase. The private `@openbot/policy`
workspace has no current runtime, oracle, packaging or external published-package consumer;
its unused evaluator has been removed. Current tool selection, admission and approval facts
are enforced by Python `work_product_runtime`, the per-tool adapters and `work_store` /
`work_effects`. Removing the old package does not change these checks or revive Node authority.
The historical rationale above remains intact; see the [current code map](../REPOSITORY_MAP.md)
and [accepted cleanup evidence](https://github.com/Peerframe/openbot/pull/104).
