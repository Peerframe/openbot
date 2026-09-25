# Research: Exact historical credential-scan fixture triage

- Status: Accepted
- Date: 2026-09-08
- Owner: @yxflc11
- Related issue: CI run `34207930929`, security job on main `979c989`.
- Acceptance journey: Complete Git history remains scanned; one reviewed synthetic URL fixture
  does not block unrelated builds, while every other finding or scanner failure blocks CI.
- Security boundary: No credential verification, result upload, history rewrite, detector exclusion,
  or whole-file exclusion. Candidate values stay in temporary runner files and never enter logs.

## Search evidence

- GitHub queries: `trufflesecurity/trufflehog exclude findings false positive git history allowlist`.
- Reviewed [TruffleHog source](https://github.com/trufflesecurity/trufflehog/tree/20652fbbdefffcdaa493a5bf57ab2ac6b1db715b),
  especially `main.go`, `pkg/sources/git/git.go`, URI detector and Git parser tests;
  [upstream ignore guidance](https://github.com/trufflesecurity/trufflehog/blob/20652fbbdefffcdaa493a5bf57ab2ac6b1db715b/PreCommit.md),
  and [path exclusion issue #420](https://github.com/trufflesecurity/trufflehog/issues/420).
- Existing review: [DEV-001 hardening](dev-001-short-term-hardening.md), CI dependency and secret
  scanning entry in [reuse ledger](../OPEN_SOURCE_REUSE.md).
- Reproduction: the exact pinned image returned 0 for main-only history and 183 after fetching all
  remote branches as CI does. There was one URI finding in `apps/server/src/model-web-tools.test.ts`,
  line 188, commit `9cc73c9e78451e572f57d142d6b9caf62ccb78e2`. The source deliberately rejects
  a URL with synthetic username/password on reserved `example.com`; it is not an account credential.
  Both candidate fields have SHA-256 `1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e`.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Existing TruffleHog plus JSON adapter | `3.97.1`, `20652fbbdefffcdaa493a5bf57ab2ac6b1db715b`; existing image digest retained | AGPL-3.0 external tool | Existing reviewed release, source and detector/parser tests; local real scan reproduced | JSON exposes commit/path/line, detector, verification and exact candidate; exit 1 takes precedence over findings exit 183 | Select thin adapter |
| Native path/detector exclusion | Same pin | AGPL-3.0 | Documented CLI flags and source | Would exempt other values in the file or detector | Reject broad exclusion |
| Inline ignore or editing current fixture | Same pin | AGPL-3.0 | Upstream documents inline ignores | Cannot annotate an immutable historical line without rewriting published history | Insufficient for this historical finding |
| Gitleaks replacement | `v8.27.2`, `c7acf33`, already reviewed in DEV-001 | MIT | Maintained static alternative | Would change the existing detector coverage to solve one known false positive | Retain as reserve |

## Reuse decision

- Selected: reuse the pinned TruffleHog JSON output and exit contract through a small Node adapter.
- Exact local gap: accept only the reviewed combination of immutable commit, path, line, URI
  detector ID/name, unverified state, and SHA-256 of both raw candidate fields. Do not exempt any
  other commit, path, detector, candidate, or verified finding.
- Keep scanning all fetched history. Require exit 0 with no findings or 183 with findings; reject
  scanner errors, invalid JSON, malformed findings, oversized output and inconsistent exit/results.
- No dependency, scanner source copy, or substantial adaptation. The external scanner is neither
  linked nor shipped; its existing license treatment is unchanged.
- Replace the adapter with an upstream exact historical finding mechanism if one becomes viable.

## Verification plan

- Negative tests for changed commit/path/line/detector/value, verified findings, mixed findings,
  malformed/oversized output, scanner errors and inconsistent exit codes; never print candidates.
- Workflow regression tests retain full-history, read-only, digest-pinned scanning and require the
  JSON adapter without failure bypasses. Run `npm run check` and replay actual full-history output.
- GitHub-hosted CI provides the final Linux runner evidence; local Docker on macOS only proves
  the pinned scanner and adapter behavior on that environment.

## Desktop UI PR historical fixtures (2026-09-09)

PR #23, CI run `34344341115`, security job `102442260610` passed the production dependency audit
with zero vulnerabilities, then failed the exact-finding adapter. Replayed the same digest-pinned
TruffleHog image with verification disabled, no update, read-only temporary Git checkout and
`--network none`. The completed scan returned 183 with three URI findings: the previously reviewed
fixture and two additional synthetic negative-test URLs. Candidate values were not printed.

Reviewed the exact pinned [URI detector source](https://raw.githubusercontent.com/trufflesecurity/trufflehog/20652fbbdefffcdaa493a5bf57ab2ac6b1db715b/pkg/detectors/uri/uri.go)
and the existing candidate comparison above. Search terms: `trufflesecurity/trufflehog false
positive git history URI credentials allowlist`. Retain the same released detector and thin JSON
adapter: modifying only today's tests cannot remove immutable published history, while path or
URI-detector exclusions would conceal unrelated findings. No dependency update or scanner bypass
is needed.

| Commit | File and line | SHA-256 of Raw | SHA-256 of RawV2 | Review |
| --- | --- | --- | --- | --- |
| `c095669dbb4e241d2999867e3778b1b4408a83fa` | `apps/desktop/src/desktop-support-links.test.ts:29` | `5cb295befc1b5d1ef305b1741773eb77b2488034068900f6303cff28085306e9` | `867b18066ef99681db5cac0d82c24537671436661eb4e73669beaaece989885c` | Fixed support-link rejection test; fake userinfo, mocked OS opener never called |
| `e8fa933dbd94751ee01974bb16e53158760f1c26` | `apps/server/src/native-web-tools.test.ts:99` | `10a105928f8eee716169d4b157b0976a7ac565f1262cfb11c2aee2d4f711a07d` | `41a0b7336302d4c7c07f4f5620b3f87a03d8ef3c2e08a925d7eb91f3e54de986` | Provider endpoint rejection test; fake userinfo, mocked fetcher never called |

Both findings use detector 17 / URI, `Verified: false`; unlike the original fixture, their RawV2
fields include a path, so each raw field needs its own exact digest. Extend the immutable tuple
list only by these two reviewed entries. Rewrite current negative fixtures using URL username and
password setters so later test edits do not introduce fresh literal credential-pattern findings.
The exercised rejection behavior remains identical. Test mutations of every tuple field, mixed
unreviewed findings and scanner errors, then replay the actual complete result file. No scanner
source is copied or substantially adapted; all existing security gates remain enabled.

Validation completed: 13 credential/workflow contract tests, 20 Desktop support-link tests and
31 native-web-tools tests passed. The complete offline scanner was replayed against a disposable
Git clone containing the candidate fix as a temporary commit; it returned only the same three
historical findings, and the adapter passed with `3 exact historical fixture(s)`. The disposable
commit was never pushed. Hosted CI on the final combined commit remains the release gate.

## Plugin admission fixture (2026-09-10)

PR #29 failed because full history adds one URI match from commit `cb057607a100ccc10dd4cec6eece6c9cfc4a5158`, `apps/server/src/plugin-service.test.ts:385`. The exact pinned scanner replayed offline over a disposable clone reports four matches total, zero verified secrets. Source inspection confirms the extra literal is a synthetic `example.com` userinfo URL in a negative `normalizePluginEndpoint` test, with no request sent. Raw SHA-256: `1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e`; RawV2: `64af6524d4fcec9a8688550461aea8ddd09ec210db19f00be93ddc558b2b5ebb`. Extend the same immutable commit/path/line/detector/hash tuple, with mutation tests, and construct the current fixture through URL setters to avoid new historical matches. No detector/path exclusion, verification, upload or scanner change.

## Contributor PostgreSQL rejection fixtures (2026-09-23)

PR #85 CI run `35812975675`, security job `107028356527`, passed the production dependency
audit with zero vulnerabilities and then failed the exact-finding adapter. Before implementation,
replayed the unchanged digest-pinned TruffleHog image against a disposable clone of all remote
branches, checked out at `97745c13412972b2440a5914c20e8fd44f99e7df`. The read-only, offline scan
(`--network none`, verification and updates disabled) completed with exit 183 and six unverified
findings: the four reviewed URI fixtures and two PostgreSQL rejection fixtures in the published
`codex/collaborative-development` branch. This branch is scanned even though it is not merged.
Raw candidates and scanner diagnostics remain in permission-restricted temporary files.

Search terms: `repo:trufflesecurity/trufflehog exact false positive URI git history allowlist`.
Rechecked the fixed release [v3.97.1](https://github.com/trufflesecurity/trufflehog/releases/tag/v3.97.1),
its [PostgreSQL detector](https://github.com/trufflesecurity/trufflehog/blob/20652fbbdefffcdaa493a5bf57ab2ac6b1db715b/pkg/detectors/postgres/postgres.go),
[detector tests](https://github.com/trufflesecurity/trufflehog/tree/20652fbbdefffcdaa493a5bf57ab2ac6b1db715b/pkg/detectors/postgres),
[CLI](https://github.com/trufflesecurity/trufflehog/blob/20652fbbdefffcdaa493a5bf57ab2ac6b1db715b/main.go),
and [path exclusion issue #420](https://github.com/trufflesecurity/trufflehog/issues/420).
The PostgreSQL detector normalizes both raw fields to the connection authority with an explicit
default port, while preserving the original source match for line metadata. Hashes must therefore
come from the actual pinned scanner output, not the input URL text. The existing exact adapter
remains the first viable option: detector/path exclusions are broader, editing a current test does
not remove published history, and replacing the scanner changes detection coverage unnecessarily.
The existing AGPL-3.0 external-tool license boundary and pinned image remain unchanged.

| Commit | File and line | Detector | SHA-256 of both Raw and RawV2 | Review |
| --- | --- | --- | --- | --- |
| `d854e2afa62c90455570fae502f9a1616d320794` | `scripts/smoke-dev-fixture.test.mjs:31` | `968` / `Postgres` | `a0010550bccff9bf7c0aa79e783a4e21558de033364bf51b00eea5d850faa23f` | Synthetic `example.com` target in the loopback-only URL rejection test; `validateDatabaseUrl` parses and rejects before any database operation |
| `716c2867beac3467be5eebe6b134e343b0523296` | `scripts/verify-retained-upgrade.test.mjs:20` | `968` / `Postgres` | `23f48618df08767413e1310aa3a841b4384d4c687087792223e06e4141cb516a` | Synthetic `db.example.com` target in a loopback-only rejection test; `validateUpgradeTarget` only parses/asserts, and the test also checks that failure text omits the password |

Decision: extend only the exact immutable tuple list by these two findings. Bind detector ID and
name to each tuple, so the four URI exceptions remain URI-only and the new two remain PostgreSQL-only.
Keep `Verified === false`, commit, path, line, and both raw hashes mandatory. No dependency,
upstream source copying, changed scanning scope, credential verification, or upload is introduced.
Do not add generic exceptions for test files, example domains, PostgreSQL findings, or unverified
results. Replace the adapter only if a maintained upstream mechanism can enforce the same exact
historical boundary.

Verification plan: replay all six real findings against the adapter, test every tuple mutation
including substitution with the other allowed detector, and retain scanner-error/malformed/mixed
output rejection. Construct regression values through URL setters without new literal credential
URLs. Run the focused security/workflow contract tests and rescan a temporary candidate commit with
the same pinned offline scanner. The complete repository check and final hosted CI remain required.

Validation completed: all 15 credential/workflow contract tests, focused Biome checks, and
`docs:check` passed. The real six-finding output passed the strict adapter. A second full-history
scan included the four candidate files in a local-only temporary commit and again returned exit
183 with exactly the same six reviewed findings; the adapter passed, with no new candidate finding.
The integration worktree was not committed or pushed during this review. The parent integration
check also completed `npm run check` successfully; hosted CI on the final published commit is the
remaining merge gate.

## Python migration draft fixtures and content digests (2026-09-25)

Before publishing the migration draft, the unchanged pinned offline scanner inspected a
standalone clone of the exact candidate branch. It returned 183 with twelve findings: three
previously reviewed historical URI fixtures and nine new exact tuples below. No verification,
upload, broad exclusion or detector change was used. A recursive check of the two synthetic
native-task histories also inspected decoded payload strings for credentials and private paths.

Inspected the immutable source lines before extending the existing tuple list. Six new findings
are five negative URL fixtures (one is reported twice at distinct line offsets): Desktop rejects
an external database before process creation; model connections reject userinfo; public-source
validation rejects userinfo before network access; model receipt configuration refuses credentials;
and the protocol schema rejects userinfo. These contain deliberate fake values on reserved domains
or localhost. The scanner reports the public-source fixture at both lines76 and81; the literal is
at81. Preserve each reported tuple exactly, without accepting a line range.

The other three values are content digests: two fixed gVisor binary hashes (also recorded in the
reviewed binary inventory), and the historical WorkTasksEntry source SHA-256. The pinned official
[Sentry v1 detector](https://github.com/trufflesecurity/trufflehog/blob/20652fbbdefffcdaa493a5bf57ab2ac6b1db715b/pkg/detectors/sentrytoken/v1/sentrytoken.go)
accepts64 lowercase hex characters near a case-insensitive `sentry` prefix; gVisor binary names
and WorkTasksEntry accidentally match that context. They are not service tokens. RawV2 is empty
for these three results. This reuses the existing reviewed TruffleHog3.97.1 adapter and AGPL-3.0
external-tool boundary; no upstream implementation is copied or linked.

Decision: add only these nine commit/path/line/detector/verification/raw-hash tuples. Preserve all
existing mismatch, scanner-error and inconsistent-result refusal. Test every new tuple and mutations
of its fields, then replay the exact full-history output and scan the committed follow-up before
publishing. No source or binary acceptance pin is changed to hide a detector match.

| Commit | File:line | Detector | Raw SHA-256 | RawV2 SHA-256 |
| --- | --- | --- | --- | --- |
| `778236bdb01014f62aa590e22389263a4c5ec4ee` | `apps/desktop/src/python-server.test.ts:87` | `968` / Postgres | `c6a2596aaaad66778be7c26f55d25dcbd4dbc54d5b985c4eca99ac02d9532c2e` | `c6a2596aaaad66778be7c26f55d25dcbd4dbc54d5b985c4eca99ac02d9532c2e` |
| `778236bdb01014f62aa590e22389263a4c5ec4ee` | `apps/server-python/tests/test_model_connections.py:95` | `17` / URI | `99829bbe372d9735dbb6bc6c0e37bd5c3915f2b358455788fca51621b8c4c997` | `99829bbe372d9735dbb6bc6c0e37bd5c3915f2b358455788fca51621b8c4c997` |
| `778236bdb01014f62aa590e22389263a4c5ec4ee` | `apps/server-python/tests/test_public_source.py:76` | `17` / URI | `1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e` | `1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e` |
| `778236bdb01014f62aa590e22389263a4c5ec4ee` | `apps/server-python/tests/test_public_source.py:81` | `17` / URI | `1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e` | `1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e` |
| `778236bdb01014f62aa590e22389263a4c5ec4ee` | `apps/server-python/tests/test_work_model_receipts_postgres.py:44` | `17` / URI | `d27f4ddbd325cde074e00ff1c583ebb6dfe5f649e8ed4a7782c0853cfbfd14bc` | `3637dbb5222f14ede4ee81c299ca7d04ad5f8492d40c1a52bfd84cb3347ddad6` |
| `778236bdb01014f62aa590e22389263a4c5ec4ee` | `experiments/linux-execution/REAL_HOST_DEADLINE.json:9` | `87` (content digest) | `15ff853549b0957c0de5f3e8db4edc74d4fbdc10fda10276d0bedf1b31c0d75f` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `778236bdb01014f62aa590e22389263a4c5ec4ee` | `experiments/linux-execution/protected_native.py:24` | `87` (content digest) | `3488860627e07cf82ec8321f043b8f12578e7b01106da1d0cd0528ba73cc3af6` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `778236bdb01014f62aa590e22389263a4c5ec4ee` | `packages/protocol/src/model-services.test.ts:46` | `17` / URI | `d88f84291a4085c5aa7a5c1aab71a7baf64065e805c8c2c60c51aabf7ec55af9` | `d88f84291a4085c5aa7a5c1aab71a7baf64065e805c8c2c60c51aabf7ec55af9` |
| `ef1e2545101766284a2104647015a4c5a5638dfc` | `docs/research/s2-work-supervision.md:73` | `87` (content digest) | `5fb64d41242d2546f1713381ae57f7ea5b8e8e1e2f17023d63c7d3cc3c2e5de6` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Validation: all15 focused credential/workflow cases passed, including mutations of every
new tuple field. The original twelve-finding offline result passed the exact adapter.

A second scan reported the other reviewed gVisor binary on the adjacent inventory line.
The pinned detector iterates a map of unique candidates and the existing unverified-result filter
can select either digest in a chunk. Bind both actual binary digests at their exact historical
locations; do not rely on output order or exempt a detector/path/line range. This adds two tuples,
one actually observed on the second scan and one derived from the same inspected immutable
binary-map line and detector. The resulting17-entry regression set covers both possible results.

| Commit | File:line | Detector | Raw SHA-256 | RawV2 SHA-256 |
| --- | --- | --- | --- | --- |
| `778236bdb01014f62aa590e22389263a4c5ec4ee` | `experiments/linux-execution/REAL_HOST_DEADLINE.json:8` | `87` (content digest) | `3488860627e07cf82ec8321f043b8f12578e7b01106da1d0cd0528ba73cc3af6` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `778236bdb01014f62aa590e22389263a4c5ec4ee` | `experiments/linux-execution/protected_native.py:24` | `87` (content digest) | `15ff853549b0957c0de5f3e8db4edc74d4fbdc10fda10276d0bedf1b31c0d75f` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
