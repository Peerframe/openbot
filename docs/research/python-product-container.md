# Research: Python product Server container candidate

- Date:2026-09-25. Status: integrated candidate; local Linux arm64 image and disposable smoke passed.
- Acceptance: build the actual Python Owner/product API and built Web without the retired TS
  business Server/oracle, preserve canonical43 PostgreSQL and owned files across stop/restart,
  run synthetic document parsing, reject invalid startup before fresh schema mutation.
- Boundary: Server remains the sole authority. Explicit existing mTLS Temporal config enables its
  existing ProductWorkService; no embedded engine, automatic provider, Node command or browser grant.

## Reviewed sources and reuse

Read OPEN_SOURCE_REUSE, python-server-container, server-node24-production-container,
desktop-python-product and python-parser-runtime-retirement; retained Drizzle/schema/parser and
Worker lock reviews apply unchanged. The old runtime-python image starts TS Server plus a child;
its historical27-migration acceptance is not evidence for this full product candidate.

Primary sources checked2026-09-25: official [Python source](https://github.com/docker-library/python/blob/3362634339580d3232e65a66dd5a36c47ae7ff14/3.12/slim-bookworm/Dockerfile),
[Node source](https://github.com/nodejs/docker-node/blob/93a7bafc324a85ac1ee461604cff87cffacb6d7a/24/bookworm-slim/Dockerfile),
[Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/),
[Compose merge semantics](https://docs.docker.com/reference/compose-file/merge/), and existing
npm10.9.9 lock/workspace projection source. No dependency/version/framework is introduced.

Pins retained: Python3.12.13 slim-bookworm index4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2
(source3362634339580d3232e65a66dd5a36c47ae7ff14, MIT/PSF/Debian component licenses);
Node24.21.0 bookworm-slim index2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
(source93a7bafc324a85ac1ee461604cff87cffacb6d7a, MIT image/Node/component licenses); npm10.9.9.
The unchanged Worker lock currently has63 distributions including pytest/development helpers;
this is an exact reproducible profile, not a claimed production-minimal Python environment.
Create its venv at the same final absolute path on the same official Python base in both stages,
install exact binary wheels only, pip-check and verify the complete existing profile.

## First viable adapter

Use a separate Dockerfile.product and explicit standalone Compose file so existing defaults do
not change and named volumes are distinct. Reuse collectProductionPackageGraph on the independent
packages/python-node-runtime root. A narrow build projection adds only the already locked Web
and TypeScript build roots, then uses the same resolver; it is not a new dependency resolver.
Build DB/protocol/domain and real Web normally. Final Node closure remains the original43 locked
third-party entries (architecture filtering still applies) plus retained DB and metadata workspace.
No apps/server, legacy oracle, host venv, credentials or environment file enters the selected context.
Retain installed notices and project THIRD_PARTY_NOTICES. No upstream source is copied/adapted.

The container entry validates the exact installed Python profile, explicit Owner/origin settings,
fixed parser assets and optional mTLS configuration before the short retained Drizzle migrator;
then execs the original serve.py as PID1. Node handles only retained migrations/parsers/locale codec.
The explicitly authorized product seam is OPENBOT_CONTROL_HOST allowing127.0.0.1(default) or0.0.0.0 before DB/key
initialization. Invalid/empty values fail before those initializations; neither cookies, origins nor proxy trust changes. Compose publishes only host
loopback; its PostgreSQL is not host-published. Read-only filesystem, nonroot UID1000 and owned
persistent state retain prior container boundaries. No SSH/remote deployment/publication occurs.

## Verification and claims

Local tests: graph identity/no-oracle closure, selected build roots, no version/integrity drift,
Docker/Compose/default boundaries, preflight failure ordering, host validation/default binding.
Independent smoke uses only uniquely owned disposable containers/network/volume, actual Owner
HTTP and Web, canonical43 hashes, synthetic Office/PDF/OCR, key/files/SQL restart persistence,
graceful stop and missing/invalid configuration before migrations. It never uses existing data.
Actual image build, Linux architecture and smoke results must be recorded separately by root.
No real model billing, Work execution without configured Temporal, Linux Node command/browser
support, live-volume upgrade or public deployment is established by this candidate.

## Checkpoint evidence and remaining gates

7 Node projection/static tests and35 Python entry ordering/refusal/host tests passed locally.
Exact npm10.9.9 `ci --offline --ignore-scripts` installed both independent lock projections from
integrity-verified public cached archives on macOS arm64 (35 runtime packages,165 build packages).
DB, protocol, domain and Web TypeScript checks and the actual Vite8.3.0 Web build passed without
the business Server/oracle. The first Vite build exposed the existing Web import of the fixed
`apps/desktop/resources/openbot-icon.png`; only that public branding asset was added to the
selected build context. It is emitted as a Web asset, not a Desktop runtime dependency.
The assembled local runtime passed the Node24.21.0 preflight (43 migration journal entries and
actual DB API import) and synthetic DOCX/PDF text extraction plus offline blank OCR initialization
through the unchanged Python parser. Blank OCR does not establish recognition quality.
Those preparation checks did not build or launch Docker. Root subsequently built the actual pinned
Linux arm64 image and ran the disposable smoke successfully on 2026-09-25: real Owner HTTP and
built Web, 43 migration entries, DOCX/PDF and blank OCR, key/files/schema restart persistence,
four invalid-startup-before-schema cases, SIGTERM without forced kill and complete owned cleanup.
The exact image and source hashes are in [PRODUCT_CONTAINER_RESULT.json](../../deploy/server/PRODUCT_CONTAINER_RESULT.json).
The integrated npm check passed with 33 test tasks and 20 build tasks (unchanged tasks reused cache).
This local Docker VM evidence is distinct from native Linux CI. No Temporal, provider, existing
volume or production deployment was used. Native amd64/arm64 CI remains a separate gate.

Inspected installed pinned Uvicorn0.53.0 server.py capture_signals: shutdown restores old handlers
and re-raises the captured SIGTERM. The prepared smoke therefore accepts exit0 or143 and refuses
forced-kill137, without claiming that an exit code alone proves product success.

## Native CI wiring

Reuse the existing native amd64/arm64 `server-container` matrix and immutable
[upload-artifact v7.0.1](https://github.com/actions/upload-artifact/tree/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a),
reviewed against GitHub's [step timeout contract](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepstimeout-minutes).
Preserve both old container checks and the25-minute job bound. Append product Compose/Dockerfile
validation, native image build, this same disposable smoke, and a7-day sanitized JSON artifact.
Per-step bounds are2/12/6/1 minutes within that total; no new job, dependency, release or retry
framework is added. Existing parser/security tests and full YAML comparison passed25 checks.
Only success JSON is retained; raw environment, Docker stderr and database state are not artifacts.
Hosted results must be read from the corresponding commit, not inferred from local qualification.
