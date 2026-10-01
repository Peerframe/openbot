# Research: Server Owner timezone and new Employee model defaults (C7)

- Date: 2026-10-01
- Decision: reuse PostgreSQL Owner transactions, revision guards and existing model connection resolution.

Read the identity/profile and model-service entries in OPEN_SOURCE_REUSE and the existing
`PostgresIdentityStore` / `ModelConnectionsService.resolve_in_transaction` contracts at main
`57341154b19d45686b2f71bce96fca38e1f07310`. Compared Desktop-local preferences, the legacy single
model settings file, event-only configuration, and a typed PostgreSQL singleton. Choose the singleton:
Owner settings belong to the Server, have bounded typed fields, and share audit/revision publication
with existing transactions. No parallel credential store or new dependency is needed.

Reviewed Python 3.12 [ZoneInfo documentation](https://docs.python.org/3.12/library/zoneinfo.html)
and PostgreSQL17 [row locks](https://www.postgresql.org/docs/17/explicit-locking.html).
Search terms: `Python zoneinfo IANA available_timezones`, `PostgreSQL FOR UPDATE optimistic revision`.
IANA lookup is authoritative on the Server, preceded by a bounded non-path key syntax check. Keep
UTC instants in existing APIs; this setting supplies Owner display timezone, not rewritten historical
instants or an automatic change to already configured schedules.

A new Employee with profile `model` or `docker-linux` and no explicit model uses the current default
selection in its creation transaction. Resolve enabled connection, endpoint policy and key there;
missing/disabled/unavailable defaults fail closed. Explicit models retain precedence. No existing Bot
or execution profile is changed; a non-model profile never inherits model capability. Owner preference
and model locks precede identity publication; creation/evolution/audit commit together. No paid provider
call, model discovery or inference runs when editing settings. No source copied or substantially adapted.

C2 and C7 are independent PRs based on the current 46-migration main. Their additive migration journal
entries must be rebased/re-indexed against the first merged migration before the second PR merges;
never replace an already committed migration or mix these branches' dirty state.
