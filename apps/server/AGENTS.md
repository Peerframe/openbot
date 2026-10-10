# Server contributor rules

This is the single TypeScript control plane from [ADR-0050](../../docs/decisions/0050-typescript-control-plane.md).
Read [README](README.md), the [repository map](../../docs/REPOSITORY_MAP.md) and the
[shared protocol rules](../../packages/protocol/AGENTS.md). Legacy Python packaging/CI retirement
is still pending; it is not a fallback or an additional writer inside this Server.

Keep identity, authorization, routing, approvals, budgets, task/action facts, publication and audit
in the Server. Validate original authority in the owning transaction; preserve committed results
when a caller disconnects or a later session check would fail. Reuse shared errors, Owner sessions,
bounded SQL pools and named advisory namespaces. Never retry an unknown effect.

Temporal owns durable continuation. Workflows remain deterministic; external effects belong to
Activities using the existing trusted ports. New TS histories use their versioned queues; the
upgrade preflight in deploy/server verifies old SQL and Temporal histories are drained before
admission. Preserve SQL history and frozen oracle provenance.

The product entry requires the complete validated configuration, private owned storage and actual
Temporal connectivity. Use disposable PG/Temporal fixtures and synthetic providers for checks.
Run affected unit/integration scenarios plus the architecture guard; complete npm run check and
the whole TS UI journey before handoff. Native packaging, actual installation, platform qualification
and Claude's final docs/Web review remain separate evidence. Preserve installed apps and profiles.
