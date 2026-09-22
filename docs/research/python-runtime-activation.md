# Research: explicit Python runtime activation

- Status: Accepted for Server startup wiring; end-to-end activation evidence pending
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Acceptance journey: An administrator can select the installed Python loop at Server startup;
  missing or incompatible installation fails before database migration or interrupted-Run recovery.
- Security boundary: Selection is trusted process configuration, not a request, model or plugin
  field. Identity, credentials, approvals, budgets, persistence and public output remain in Server.

## Search evidence and candidates

Reuse the completed [host](python-runtime-host.md), [transport](python-runtime-transport.md) and
package dependency reviews. The existing reuse ledger covers Node child-process APIs, Zod config
and the installed SDK. Official Python [command-line documentation](https://docs.python.org/3.12/using/cmdline.html)
defines `-I` (ignores PYTHON variables, cwd and user site) and `-u`; the
[venv contract](https://docs.python.org/3.12/library/venv.html) explains package-local environments.
These flags do not provide OS isolation. Retain the reviewed Node v26.0.0 child-process source and
Python 3.12.13 reference runtime; do not add a process-manager dependency or an auto-install service.

The first viable implementation is a thin startup adapter over these existing APIs: use a fixed
repository-relative Python package, its local venv, its locked-environment verifier, and the fixed
worker entry point. No arbitrary command, script path, shell string or network installer is
accepted through configuration. A bounded, minimal-environment interpreter/import/lock check runs
before any durable Server initialization. It neither enables inference nor calls a provider.
Missing, timed-out or incompatible preflight is fatal with a bounded message and no fallback.
TypeScript remains the default and requires no Python installation.

## CI candidate review (not yet wired)

GitHub search: `repo:actions/setup-python is:issue is:open 3.12`; official documentation searches:
`setup-python v7.0.0`, `Python 3.12 isolated mode venv`. Reviewed release v7.0.0, pinned commit
`5fda3b95a4ea91299a34e894583c3862153e4b97` (MIT), `action.yml`, `src/setup-python.ts`,
`src/find-python.ts`, `__tests__/find-python.test.ts` and LICENSE. The action runs on Node 24,
resolves an exact interpreter through the maintained tool cache/manifest and supports explicit
version selection. Open issues include macOS pythonLocation differences (#813), empty pip cache
failure (#815) and binaries needing LD_LIBRARY_PATH (#871). The worker deliberately strips that
variable, so hosted-action compatibility remains to be tested before selecting this CI route.
Do not solve it by forwarding unrestricted Server environment variables to workers.

## Verification and incorporation

No copied or substantially adapted upstream source; no added dependency. Test default behavior,
strict selection, fixed launch arguments, minimal environment, absent files, failed imports/lock
verification and bounded output. The real Python/Server/database lane must then use the same
startup selector and demonstrate successful delivery. Linux reference installation and the
existing `npm run check` remain mandatory; this startup adapter alone does not prove them.

## Startup wiring evidence

The installed Python package passed the actual minimal-environment import/lock preflight on
macOS. Six startup launch-boundary tests and the strict environment selection test passed.
`npm run check` exited zero (Server 622 passed / 84 database-dependent skips); the default
headless command separately passed 219 cases across nine files with its disposable PostgreSQL.
The Python lane was attempted while TASK-003 remained in progress and stopped at four package
unit failures before creating a database; this is diagnostic feedback, not an accepted handoff.
The original Node container contract still passes. Local collaboration data, virtualenvs and
Python caches are now excluded from Docker context, reusing the existing container review.

## Linux acceptance environment

Select a disposable multi-stage Docker test fixture instead of depending on a hosted Python
interpreter's library search environment. Reuse the existing reviewed Node 24.21.0 Bookworm image
(index `sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`) and official
Python 3.12.13 slim-bookworm amd64 manifest
`sha256:6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af`.
Read the official Python Dockerfile at docker-library/python commit
`3362634339580d3232e65a66dd5a36c47ae7ff14`: it verifies the Python tarball SHA/signature, builds shared
Python with origin-relative libpython rpath, retains discovered runtime libraries and runs version
checks. Its #784 reference explains the rpath decision. Image source is MIT, Python PSF-licensed,
with the bundled Debian component licenses. No source is copied; reuse the built images.

Copy the fixed Node binary/npm into the compatible Python Bookworm fixture, select npm 10.9.9,
install existing locked Node/Python dependencies, then execute as UID/GID 1000. The preliminary
build succeeded with Node 24.21.0, Python 3.12.13 and the package lock. This is a development/test
image, not the production container or an OS sandbox for untrusted programs.

The repeatable runner owns a no-network PostgreSQL container, joins only that container's loopback
namespace for testing, publishes no host ports, supplies no model credentials and cleans both
containers on exit. First build requires public registry access; execution has no external network.
Reuse the existing paired acceptance command inside it. Local amd64 execution on this Mac is
emulated; native hosted CI evidence, when available, must be recorded separately.

First Linux snapshot: fixture built successfully and ran as UID/GID 1000 with no external network.
Python reported 340 passed / 5 failures in 165.83s while TASK-003 was still being edited; the runner
correctly refused to continue into Server/database integration. Failures concern CLI lifecycle
expectations (deadline/broken pipe, authority refusal and unserviced post-model authority checks).
They remain review items, not accepted platform support. The subsequent headless harness now
returns on the first failing Python test to keep iteration short while retaining the full green
suite requirement. The Linux fixture containers and its unique image are removed on exit.


## Required Linux CI lane

Reuse the already-reviewed CI checkout/setup-node pins and the Docker fixture above, rather than
introducing another Python installer. The host Node 22.22.2 runs only the fixture orchestrator;
the pinned image owns Node 24.21.0/Python 3.12.13 and both lockfiles. Use ubuntu-24.04 amd64,
read-only repository permissions, checkout without persistent credentials, no publication and a
25-minute job limit. Add its result to the existing protected check gate. No new action,
dependency or copied source. Local Linux results and native hosted execution must be distinguished;
adding the workflow does not claim it has run remotely. Existing workflow validation tests enforce
that every job is included in the protected success check.


## Linux fixture environment observation

The first complete Linux rerun passed 367 Python tests and all actual Owner/delegation journeys,
but two Node-based interpreter fixtures rejected UV_USE_IO_URING=0 (220/222 Server tests passed).
Independently reproduced using the pinned official Node image, network disabled, and
`env -i LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/local/bin/node -p 'JSON.stringify(process.env)'`:
only the two supplied locales plus UV_USE_IO_URING=0 are visible. `env -i /usr/bin/env` is empty.
Thus the extra value is not inherited from the Server's environment. The precise Node/emulation
injection mechanism is not established: reviewed v24.21.0 src/node.cc, node_main.cc,
node_process_methods.cc and bundled libuv linux.c; the latter documents the variable as an io_uring
switch but does not establish its setter. Do not generalize this observation to every platform.

Correct only the two Node test-double assertions: on Linux accept that exact key with value 0,
while refusing any other value/extra key and retaining private-variable absence checks. Production
spawn/preflight still pass only LANG and LC_ALL. No dependency, protocol or authority change.
Rerun the Linux lane and full checks; previous failed attempt remains historical evidence.


## Standalone source-install startup verification

The built apps/server/dist/index.js was launched from an empty temporary working directory with
OPENBOT_AGENT_RUNTIME=python, minimal synthetic configuration, temporary object/model directories
and an owned fresh PostgreSQL instance. Actual interpreter preflight, database migrations, HTTP
health, Owner login/session cookie and authenticated channels API all passed. No model setting
or provider call was enabled. The process group, temporary directories and fixture database were
removed afterward. This is source-install startup evidence, not a Python production-container claim.


## Final reference acceptance (2026-09-23)

The Linux/amd64 fixture exited zero: 369 Python tests (137.20s) and 222 Server/PostgreSQL tests
across nine files (73.26s). This includes the two late WorkBuddy CLI regressions for post-revocation
silence and whitespace refusal, which Codex reviewed and also reran in the 31-case macOS lifecycle
file. The TypeScript lane passed 222 tests with the same Unicode report. Full npm run check passed,
as did standalone built-Server health, Owner login and workspace API with Python selected.
The required CI lane is wired but has not executed remotely. All owned fixture containers and
unique acceptance tags were cleaned. No live provider request, publication or deployment occurred.
