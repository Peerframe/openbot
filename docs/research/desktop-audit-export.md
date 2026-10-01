# Research: bounded audit categories and CSV export

- Date: 2026-10-01
- Status: Accepted for C3 implementation.
- Trigger: public export/query contract and private-data boundary.

Reuse PostgreSQL 17.11 / Psycopg 3.3.6 and CPython 3.12.13 csv (PSF); retain the
[identity lifecycle](../decisions/0047-identity-lifecycle-and-read-state.md) authority and append-only run_events source.
Reviewed [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180),
[OWASP CSV injection](https://owasp.org/www-community/attacks/CSV_Injection),
[CPython csv source](https://github.com/python/cpython/tree/v3.12.13/Lib/csv.py),
and [csv API](https://docs.python.org/3.12/library/csv.html).

Compared a third-party tabular/export engine, renderer export of loaded events and a bounded
stdlib serializer. The stdlib serializer meets quoting/CRLF requirements without a new dependency;
server-side filtering and keysets include events outside the loaded page. All text is untrusted;
formula candidates (including leading whitespace/control/BOM and fullwidth prefixes) receive an
apostrophe. Export pages share the same SQL allowlist, 1000-row/4-MiB limit and Owner authority.
SQL builds bounded scalar details before driver transfer; never export raw payloads. Category
mapping is fixed, parameterized filters select it before pagination, and unknown types map to other.

Authentication and host facts reuse their existing transaction source. The private legacy settings
file already rolls back on authority failure; add an audit guard only at final publication, not at
model verification. Physical disconnection cannot be rolled back; cleanup takes precedence and
persistence failure is surfaced by a fixed log. No renderer/Worker audit authority or new ledger.
No upstream source copied or substantially adapted. Negative tests cover secrets, CSV formulas,
query/cursor bounds, anonymous/revoked reads and settings-audit rollback with real SQL/HTTP.
