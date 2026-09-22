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
