# Research: reproducible contributor and migration workflows

- Status: Accepted for implementation
- Date: 2026-09-14
- Owner: @yxflc11
- Related issue: Owner-authorized independent repository review follow-up
- Acceptance journey: A contributor starts Server/Web without an unenrolled Node, obtains a safe manual migration plan, and identifies every required recovery asset.
- Security boundary: Migration help is read-only and never opens a database; existing migration SQL, snapshots, journal entries and startup guards remain unchanged. Node enrollment remains Owner-issued and credentials stay private.

## Search evidence

GitHub queries: `repo:drizzle-team/drizzle-orm 0.31.10 snapshot generate`, `repo:drizzle-team/drizzle-orm custom migrations`, and `repo:mozilla/pdf.js 6.3.289` on 2026-09-14. Reviewed the existing reuse-ledger entries for PostgreSQL lifecycle, Node bootstrap, backup/restore and PDF dependency coherence, plus `docs/DATABASE.md`, source-development scripts and Desktop/container persistence configuration.

- [Drizzle Kit 0.31.10 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit@0.31.10), [migrationPreparator.ts at that tag](https://github.com/drizzle-team/drizzle-orm/blob/drizzle-kit@0.31.10/drizzle-kit/src/migrationPreparator.ts), and [CLI generate tests](https://github.com/drizzle-team/drizzle-orm/blob/drizzle-kit@0.31.10/drizzle-kit/tests/cli-generate.test.ts): generation selects a previous snapshot; tests distinguish ordinary generation and `--custom`. Read published package source and upstream tests; did not run the full upstream suite.
- [Official custom migrations](https://orm.drizzle.team/docs/kit-custom-migrations) support hand-authored SQL. OpenBot retains the existing Drizzle ORM 0.45.2/Postgres.js 3.4.9 application path.
- [Open issue #5528](https://github.com/drizzle-team/drizzle-orm/issues/5528) discusses snapshot-free generation; [open issue #6093](https://github.com/drizzle-team/drizzle-orm/issues/6093) reports PostgreSQL introspection/generation asymmetry in 0.31.10. These are upstream reports, not assertions that OpenBot reproduces each case. They do not justify silently reconstructing this repository's baseline.
- Local review of commit `3a02750e8851298a1b27246fd1ac4925f319fdc1` found `0013_snapshot.json` contains no tables. The pinned CLI on an untouched disposable copy generated all 24 existing tables, and its current timestamp was behind the existing journal. Existing SQL-only constraints further rule out replacing history from the TypeScript schema alone.
- [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) documents database archive scope. Files and encryption keys outside PostgreSQL require a coordinated recovery set; this change clarifies the current runbook and adds no backup engine.
- [PDF.js 6.3.289 release](https://github.com/mozilla/pdf.js/releases/tag/v6.3.289), commit `1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56`, and [existing parser review](pdfjs-6.3-lock-coherence.md): retain the installed distribution's complete license files byte for byte; update only provenance/version metadata and any notice bytes that differ.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Drizzle normal generation | drizzle-kit 0.31.10 | MIT | Maintained release; snapshot preparator and CLI tests inspected | Requires a trustworthy baseline absent here; may emit existing DDL | Disable the misleading package entry |
| Drizzle custom migration convention with OpenBot plan | drizzle-kit 0.31.10; drizzle-orm 0.45.2; existing manifest checker at 3a02750 | MIT | Reuse checked-in SQL/journal and existing validation | Read-only plan adapts unique four-digit numbering and monotonic timestamps without rewriting history | Select thin adapter |
| Rebuild snapshots or upgrade migration format | Not selected | MIT upstream | Requires database/schema equivalence and upgrade review | Exceeds the authorized change; risks losing SQL-only constraints | Defer |
| PostgreSQL archive plus stopped Server file snapshot | PostgreSQL 17 documentation; existing Server lifecycle at 3a02750 | PostgreSQL License | Existing migration/recovery checks retained | Documents model keys/settings, plugins, objects and optional publisher credentials | Retain native tools; clarify runbook only |

## Reuse decision

Use the released migration runner and standard hand-authored SQL. A narrow Node.js helper prints a proposed journal entry and comment-only SQL template after the existing manifest validator accepts the repository. It never imports schema, invokes Drizzle generation, connects to a database, or writes files. Reject ordinary `generate` with stable guidance. The exact gap is OpenBot's numbering/time/history contract, not SQL generation. Retain the old history unchanged; reconsider automatic generation only after a separate full baseline-equivalence review.

The shortest development journey builds shared dependencies and starts only Server/Web. A separate documented step issues a one-time Node token through the existing authenticated script. Missing enrollment receives a fixed error code and actionable message; unknown storage/provider failures keep generic content-free diagnostics. No auth behavior changes.

## Source incorporation

No upstream implementation or tests copied or substantially adapted. PDF.js notices are copied verbatim from the installed `pdfjs-dist@6.3.289` distribution into `licenses/runtime/pdfjs-dist`; `licenses/runtime/sources.json` records exact paths, version and hashes. Existing MIT/Apache and independently licensed font/decoder notice text remains intact.

## Verification plan

- Node tests execute the disabled generate entry and read-only plan, check complete migration-tree hashes before/after, reject malformed/colliding history and invalid names, and check monotonic time even when the journal is ahead of the clock.
- Node client fixture verifies a missing enrollment never fetches or persists credentials and emits fixed guidance; an unknown storage error does not expose its body.
- Verify retained PDF license inventory, installed version and byte hashes; keep package staging behavior unchanged.
- Run relevant tests and bilingual docs checks; root integration runs the repository check and isolated PostgreSQL migration verification. No paid model or real user data is required.
- Runtime guidance is source-development specific. Desktop OS-protected bootstrap is not claimed portable across users/machines; backup automation and full cross-host restore remain outside this change.

## Verification evidence

On 2026-09-14 with Node 26.0.0 and npm 10.9.9, all three migration-plan tests passed, including a complete migration-directory hash comparison. The actual workspace `generate -- --custom` command exited with code 1 and the stable disabled marker. After a separate task appended migration 0026, the actual plan command selected 0027 and a timestamp greater than the last journal entry; it created no SQL file.

Both focused Node identity tests passed. The real `apps/node/src/index.ts` entry, run with an isolated empty environment and temporary credential directory, exited with code 1, emitted `node_enrollment_required` with the enrollment command, and created no identity files. No Server, Provider, external model or real credential was used.

All 11 retained PDF.js license paths, bytes and recorded SHA-256 hashes match installed 6.3.289. Two upstream notice files differ from the old retained copy: `standard_fonts/LICENSE_LIBERATION` now contains the distribution's GPL v2 font agreement and exceptions, and `wasm/LICENSE_PDFJS_QCMS` contains its MIT text. Both were retained verbatim. The existing packaging copy path remains unchanged. Documentation checks and focused Biome checks passed; the root integration owns full repository and isolated PostgreSQL acceptance.

## Unresolved questions

Automated snapshot reconstruction and complete cross-host Desktop credential recovery remain separate work. Number allocation is a preview, not a reservation: contributors must recalculate after rebasing competing migrations.
