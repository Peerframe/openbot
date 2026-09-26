# Temporal 1.31.3 -> 1.32.0 qualification evidence

Research date: 2026-09-23. Status: implementation qualification; no production acceptance.
Existing reuse: Temporal persistence, trusted transport and official SDK integration entries.
This research was recorded before adding the upgrade fixture. Reuse official MIT released binaries
and existing pinned images; no copied source, custom migration engine or product dependency.
The missing 1.31.3 container requires only a thin test-only binary bind adapter. Do not substitute
1.31.2 silently. The fixture has no authority over existing product or engine databases.

## Release/source pins

Latest published stable 1.31 patch: v1.31.3, published 2026-09-18T20:31:24Z.
Commit: 8c78934b67fbac43d2ea7f8ada448c539780584d.
Target v1.32.0: d94e34a1ebba5410a2e7d07119a76896909591aa.
Official release: https://github.com/temporalio/temporal/releases/tag/v1.31.3
Official target notes: https://github.com/temporalio/temporal/releases/tag/v1.32.0

Both entire schema/postgresql trees have Git object SHA 93e3af4f012dfed7be93a5b9356a9fc241e17bbe. Full recursive trees were fetched, neither was truncated; no PostgreSQL path/hash differs. Both version.go constants are history 1.19 and visibility 1.14. This pair exercises a genuine Server release upgrade and history compatibility, NOT a schema-DDL change. The history/visibility schema change occurred at 1.31.0.

Sources:
- https://github.com/temporalio/temporal/blob/8c78934b67fbac43d2ea7f8ada448c539780584d/schema/postgresql/v12/version.go
- https://github.com/temporalio/temporal/blob/d94e34a1ebba5410a2e7d07119a76896909591aa/schema/postgresql/v12/version.go
- https://github.com/temporalio/temporal/releases/tag/v1.31.0

## Official Docker publication gap

Both registry requests temporalio/server:1.31.3 and temporalio/admin-tools:1.31.3 returned HTTP 404 MANIFEST_UNKNOWN. Independent docker buildx imagetools inspect confirmed server:1.31.3 not found. Official Docker Hub tags APIs show only 1.31, 1.31.0, 1.31.1, 1.31.2. Do not invent a digest or call 1.31.2 latest published patch.

Latest available 1.31 container (fallback evidence only):
- temporalio/server:1.31.2@sha256:b5ecdb8282bededae2a10c36e8d862e27d0bc2d247fc73c5416025997ab4a1da
- temporalio/admin-tools:1.31.2@sha256:dbc5fcd6ee8f0f4d808bf765af9a87dea9d8a283abfdcfbd2fc148496ba66107
- v1.31.2 commit: 19a774302c613da9adc4436ab14278ccdca8e0a5

Verified target index digests (computed SHA-256 equals Docker-Content-Digest):
- temporalio/server:1.32.0@sha256:c3e752127759616bb1615e0f9ba0e21635aeb5fdeb922de4f371c350955f46ae
- temporalio/admin-tools:1.32.0@sha256:a9f84fb9a374b2374fe2e67c8efc0468ff3f1c66c8a0b14597ec86e349e62bca

The *-manifest-meta.json files preserve platform manifest digests and registry URLs. The *-manifest-error.json and *-1.31-tags.json files preserve absence evidence.

## Verified official 1.31.3 binary alternative

Downloaded both archives from the official GitHub release. Exact byte size and SHA-256 matched BOTH official checksums.txt and each GitHub release asset.digest. checksums.txt itself matches GitHub asset SHA-256 58b391e91c2ca5b34f8c33cc12b2702368a71a0a014b78ec073d16fc025bc250.

- temporal_1.31.3_linux_amd64.tar.gz: 93,822,307 bytes; SHA-256 f2c3bf9f1115b506259e5972a62c38257296c043e15798358c3fb758625b96b8
- temporal_1.31.3_linux_arm64.tar.gz: 85,585,324 bytes; SHA-256 9771a7930e2503e77510714d83b5e20f589ee846d270d4b352e1ee3fd487ed08

URLs:
- https://github.com/temporalio/temporal/releases/download/v1.31.3/checksums.txt
- https://github.com/temporalio/temporal/releases/download/v1.31.3/temporal_1.31.3_linux_amd64.tar.gz
- https://github.com/temporalio/temporal/releases/download/v1.31.3/temporal_1.31.3_linux_arm64.tar.gz

Both archives contain regular-file temporal-server and temporal-sql-tool. ELF inspection verified x86-64/AArch64 machine IDs and absence of PT_INTERP for both binaries; no runtime execution was performed. verified-binaries.json has extracted-member hashes. Extract only those exact members with regular-file/type/size validation; the whole archive includes a configuration symlink. Do not extract it indiscriminately.

A disposable fixture may mount the matching official 1.31.3 binary read-only over /usr/local/bin/temporal-server in the already-pinned 1.32.0 base image, explicitly recording this as a binary-substitution test fixture, NOT an official 1.31.3 image. Official Dockerfile and entrypoint source hashes are identical across the two commits. Their embedded SQL config is compatible; the template delta is a new SQLite branch and configurable cluster RPC/HTTP addresses. The current profile pins broadcast to 127.0.0.1, matching the former hardcoded cluster address.

## Upgrade procedure and evidence boundary

Official rule: latest patch on current minor, then next minor; schema first if required, Server second; no skipped minor. Allow approximately ten minutes on each version for all History Shards and metadata to be loaded/updated. Use staging simulation load before live deployment.
Source: https://docs.temporal.io/self-hosted-guide/upgrade-server

Proposed bounded experiment:
1. New owned volume and private network; initialize matching 1.19/1.14 schemas with the verified 1.31.3 sql-tool or record use of byte-identical schema files from pinned official 1.32.0 tools.
2. Run the verified 1.31.3 Server binary, record runtime version/binary hash, namespace ID, four shard IDs and schema metadata. Warm old Server before creating short-timeout workflow scenarios; alternatively make workflow execution timeouts cover the documented soak and upgrade pause.
3. Create approval-waiting and publication-committed/unacknowledged workflows under 1.31.3. Save a cold engine snapshot while the main recovery task still waits for approval; then approve it and lose its write receipt so newer product facts are unknown before upgrading. All owned workers are stopped at each boundary.
4. Run current guarded 1.32.0 schema maintenance. Assert versions and schema_update_history unchanged because this pair has no DDL delta. Recheck runtime metadata write denial.
5. Replace only Server binary/image with the pinned 1.32.0, retain volume/namespace and current product authority/effect facts. Resume identical worker code first. Assert workflow/run identities, action evidence, usage/reservations, zero write replay, exactly one completion event and byte-verified artifact.
6. Restore a 1.31.3 engine snapshot into fresh engine storage and open it with 1.32.0 while preserving newer product unknown/cancel state; reuse existing no-duplicate-effect assertions.
7. Fetch actual saved histories and run the SDK offline Replayer against the current Workflow implementation as a separate worker-code compatibility check. Server success alone does not qualify changed worker code.

Do not claim online rolling/HA, arbitrary-version downgrade, genuine schema-DDL migration, full-product rollback or product auth/TLS from this fixture.

## Relevant release behavior changes

1.32.0 enables unified visibility query conversion and stricter attribute type/empty-Text validation by default. Include one real ListWorkflowExecutions query and expected invalid-query rejection if the application uses visibility. Activity eager execution is now enabled by default; retain actual receipt/write-count assertions. Legacy Worker Versioning removal was deferred from the 1.31 announcement to 1.33; do not code to the obsolete removal date. Standalone activities/default CHASM callback behavior and Nexus callback routing/settings changed, but the current work journey does not use those APIs. Keep those unexercised. Both reviewed go.mod files pin Go 1.26.8; 1.31.3 security patch notes do not justify assuming the newer minor lacks that toolchain fix.


## Implementation acceptance

The command requires an explicit local archive, validates the reviewed whole-file and regular
member hashes, and creates owned temporary files. It never downloads or executes unverified content.
Use a matching Docker daemon architecture. Both source and target use native mTLS. Old server
health must remain good throughout a 600-second warm-up before the live task fixtures are created.
Four shard rows and schema metadata are checked around the stopped adjacent upgrade. Persist
waiting approval and publication-before-ack tasks before the main unknown-write case reaches the
upgrade; all three must survive with original workflow run identities and product snapshots.
Current code replays histories without activities, and held tasks first resume on the upgraded
original volume, preserving exact effect counters and verified bytes. After older snapshot restore,
the same held tasks must preserve their newer completed business results without fresh admission.
The main unknown-write task resumes after that restore, retaining its original engine run ID.
Upgrade workflows use a bounded 1200-second execution timeout, versus 240 seconds for the normal probe. The earlier cold engine snapshot is restored under the new binary
against newer product facts. Reuse existing accepted tests; do not claim a changed-schema test.

Automated checks: archive corruption/type/size/path validation, interrupted maintenance fail-closed
behavior, real PostgreSQL/mTLS adjacent release scenario, SDK replay and public artifact downloads.
Actual results follow. No online/HA/rolling claim.

## Measured qualification — 2026-09-23

The arm64 binary-substitution fixture completed successfully on Docker Desktop from macOS.
It observed 601 healthy seconds on actual Server 1.31.3 before creating tasks, then verified
actual Server 1.32.0 after the stopped upgrade. Both schema histories, all four shard identities
and the namespace remained unchanged. Both official archive/member pins were independently
checked; amd64 extraction was verified but amd64 execution awaits the configured Linux CI job.

Twelve public-work case records passed: the previous eight scenarios plus approval and committed
publication acknowledgement on the upgraded original volume and again after restoring the older
engine snapshot into new storage. Each held task kept its business result, original engine run
identity, five POST attempts, one write, eleven fixture usage units, one completion event and one
byte-verified CSV Artifact. After restore, the already-completed approval task's old engine history
stopped at the current authority check; it did not reopen execution to reproduce its result.
The unknown-write task retained its identity through upgrade and restore, then used one receipt
lookup and completed with five POST attempts, one write and eleven units. Cancellation, corrupted
receipts and all three conflicting-handoff cases retained their earlier expected outcomes.

Eleven actual histories (35–78 events) passed the official SDK/Pydantic AI offline Replayer. Each
corresponding incompatible first-command control raised NondeterminismError. Public snapshots and
independent HTTP counters were unchanged by replay. Certificate rejection/rotation, engine and
database SIGKILL, runtime SQL denial and incompatible schema rejection also passed. The complete
reference unit suite passed 57 checks; repository `npm run check` passed. Owned test containers and
volumes were cleaned. CI now invokes this gate with the pinned amd64 archive; it has not run remotely.

This qualifies only the fixed stopped 1.31.3 -> 1.32.0 service upgrade and same-code replay. The
identical schema tree means no DDL migration was exercised. It is not rolling/HA, future worker
compatibility, production PKI/RBAC, full-product rollback, live-provider quality or Linux sandbox
qualification. No production dependency/default, source push or release was changed.
