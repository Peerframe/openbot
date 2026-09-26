# Research: fenced work completion and verified artifacts

- Status: implementation qualification; no engine or executor selected
- Date: 2026-09-23
- Owner: OpenBot integrator
- Journey: current attempt publishes verified files and Task completion atomically in SQL;
  stale, cancelled or unresolved work cannot publish; authenticated downloads check real bytes.

## Primary evidence and reuse

Reviewed existing artifact-read-integrity (OCI descriptor commit
`13cff54902ec9ad6320cbc487a685b66fcd67171`, Apache-2.0), OpenBot's MIT artifact storage/completion
and PostgreSQL 17.11 row-lock transactions with psycopg3.3.6. Reuse the size-before-SHA-256
invariant and the existing Owner transaction boundary, not legacy channel-coupled publication.

Searched GitHub for Python atomic writes, CPython tempfile/os tests and reviewed the installed
CPython3.12.13 POSIX APIs against [os documentation](https://docs.python.org/3.12/library/os.html)
and [pinned source/tests](https://github.com/python/cpython/tree/v3.12.13/Lib/test).
Use POSIX descriptor-relative open/link/unlink and fsync via the standard library (PSF).
[python-atomicwrites](https://github.com/untitaker/python-atomicwrites) is archived since 2022
and explicitly unmaintained; no dependency or copied implementation is needed for this bounded
local immutable-store adapter. S3/storage-service integration is a later interchangeable file port,
not a reason to insert another service in the reference fixture. Windows file semantics are not
qualified. The local root must be a private control-owned directory, never an executor mount.

HTTP downloads follow [RFC6266](https://www.rfc-editor.org/rfc/rfc6266.html) attachment disposition,
encoded filenames, no sniffing and existing private-cache/auth handling. No filesystem path or
model-provided digest authorizes a download. The database holds the descriptor and provenance.

## Design and exact local gap

An engine-issued attempt claim gets a monotonically increasing Run epoch under the Task lock.
A replayed claim ID never gets a newer epoch or renewed grant. Expired/superseded claims cannot
propose/admit new actions or publish completion. The engine alone schedules/retries attempts;
these transaction methods are a fence, not a new polling/recovery scheduler. Epochs cannot stop
external writes unless the effect boundary enforces them; that separate qualification remains open.
Owner revocation/cancellation still serializes through the Task row. Trusted reconciliation of
already-admitted effects can record truth after revocation without granting new execution.

File bytes are bounded, hashed and written to private temporary files; flush, atomically link to
an immutable content key without overwrite, then flush the directory. Existing objects must pass
readback verification. Files precede SQL publication; on failed/cancelled SQL publication a blob
may remain unreferenced, never downloaded by guessing its key. Do not delete a shared immutable
blob on rollback. Orphan collection, storage quotas, backup/restore and power-loss guarantees
remain deployment gates; local fsync calls alone do not establish storage-system durability.

Completion rechecks the current claim, Task revision and authority, resolved applied actions and
absence of unfinished sibling Runs. A trusted result verifier supplies its bounded evidence;
models cannot claim Task success. File descriptors, result summary, terminal state and event
commit together. Repeating the same completion is an acknowledgement, not another publication;
changed content conflicts. First slice deliberately refuses completion with denied/unapplied
Actions; explicit supersession/partial delivery semantics need their own later transitions.

At download, authenticate and lock first, then read the descriptor-selected regular file with no
symlink following, bound its size and verify SHA-256. No path or HTML preview surface is exposed.
Corrupt/missing bytes fail closed. The metadata contract is independent of CSV/PDF/Office processors.

## Verification

Owned PostgreSQL + synthetic private files only. Cover stale/expired claims, generation changes,
concurrent claims, exact completion retries, pending/unknown effects, audit rollback, cancellation,
file corruption/missing/symlinks/oversize, unsafe filenames and unauthenticated downloads.
No external accounts, real model calls or original user database are involved. This slice does
not alone qualify engine admission/recovery, semantic task quality or a complete user journey.

Local acceptance: 119 real PostgreSQL/HTTP cases pass, including 14 publication cases; 22 private-file
cases pass within 810 Python package cases. The 119 database cases are skipped in the environment-
free package invocation and independently run by `scripts/test-python-control.mjs`. `npm run check`
passes. All storage/process tests use disposable fixtures; production and Linux qualification remain open.
