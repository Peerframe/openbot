# Request-local model verification and connection lifecycle (C17)

- Status: Accepted for implementation
- Date: 2026-10-02
- Trigger: public Owner commands and nullable persistent connection-default metadata.

Reuse [model-service review](python-model-services.md) and the original MIT OpenBot
feature source `9cc73c9e78451e572f57d142d6b9caf62ccb78e2`. Retain reviewed
HTTPX2 2.13.0, Pydantic2.13.5, psycopg3.3.6 and PostgreSQL17 source
`ec3f6a6a7dd82a8ce455a0710ef75172f9f318d1`; no dependency update or copied upstream source.
Primary review: [OpenAI Models GET](https://platform.openai.com/docs/api-reference/models/list),
[Anthropic Models GET](https://platform.claude.com/docs/en/api/models/list),
[PostgreSQL row locks](https://www.postgresql.org/docs/17/explicit-locking.html), and
[ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html).
Search terms: psycopg/psycopg 3.3.6 transaction tests; PostgreSQL17 FOR UPDATE FOR SHARE delete
locking; official provider model list endpoints. Existing exact released source/tests/license review
remains valid; reviewed changed assumptions are request-local key use, default metadata and deletion.

| Candidate | Fit and operational cost | Decision |
| --- | --- | --- |
| Existing bounded model-list HTTPX2 reader with a fresh Owner callback | One GET; existing endpoint allowlist, no redirects/retries, response/deadline bounds; no inference | Selected thin reuse |
| Save a temporary connection then discover/delete | Persists request-local credentials and produces unwanted audit/storage side effects | Rejected |
| Inference as verification | Costs tokens, grants more request behavior and is not the requested model-list check | Rejected |
| Nullable column on existing connection with existing revision CAS | One additive migration, no new ledger or configuration service | Selected |

Verification accepts only existing discovery-capable presets and exact allowed endpoints. It never
creates a cipher envelope, file, connection or audit event, and never issues a chat request. Recheck
Owner authority before send and before exposing results. Hide credential validation inputs and map
upstream errors to fixed categories. Unknown/oversized/redirected responses fail closed.

Append migration0049 with nullable default_model; old connections retain no default. Revision-based
updates set/clear the public model ID and audit field names only. This metadata grants no model use
and does not silently change any Bot or Owner global default.

Deletion locks the connection FOR UPDATE; validated Bot/default writers hold FOR SHARE on that
same row. Read Bots without reverse-order row locks to avoid Bot→connection deadlock. Refuse with
409 plus bounded Bot IDs/names, active Run IDs and Owner-default flag. Missing/corrupt/oversized
dependency data or a database failure cannot authorize deletion. Preserve historical receipts and
run/audit history; only the unused encrypted connection row is removed, with content-free audit.
