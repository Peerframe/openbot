# Retiring the TypeScript business Server

2026-09-26. Implementation base: `67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69`.

The Owner accepts remote Python services for Windows and Intel Mac in this milestone.
macOS arm64 retains the qualified native Python product. Existing installations, data,
credentials and PostgreSQL volumes are not deleted or silently converted.

## Reuse decision

Promote the already reviewed product composition, not a new backend. Exact dependency
and source/license reviews remain in [Python Desktop](desktop-python-product.md),
[product container](python-product-container.md), [parser separation](python-parser-runtime-retirement.md)
and [frozen oracle](legacy-server-test-oracle.md). They pin CPython3.12.13, Node24.21.0,
Electron44.3.0, Packager20.3.0, PostgreSQL17 and the existing Worker lock. No new
dependency, copied upstream implementation or permissive runtime fallback is introduced.

Before implementation, searched GitHub for Electron44.3.0 process architecture/profile
handling and read its [app API](https://github.com/electron/electron/blob/v44.3.0/docs/api/app.md),
including the existing getPath/profile constraints and issue31565. Read npm10.9.9
[workspace documentation](https://docs.npmjs.com/cli/v10/using-npm/workspaces/) and Docker
[project naming](https://docs.docker.com/compose/how-tos/project-name/) and
[volume specification](https://docs.docker.com/reference/compose-file/volumes/).
Native Electron/Node platform information and Compose project/volume separation are
the first viable standards-based options. A new service manager, portability shim or
second migration history would duplicate existing accepted mechanisms.

## Scope and acceptance

Remove the live `apps/server` workspace and its Docker/dev/CI execution paths. Keep the
frozen, test-only legacy oracle, canonical SQL histories, Node/Providers, credential
helpers, publisher and MCP packages. Replace obsolete gates with existing Python product
gates; never relabel a deleted legacy test as a passing replacement. Historical source
attribution and credential-scan exceptions remain historical references.

Default container deployment uses the reviewed Python image and distinct product volumes;
operators must select a new Compose project when migrating from the legacy deployment.
Desktop refuses local hosting outside macOS arm64 before touching bootstrap or database
files. Canonical Desktop uses a separate Python local-service directory; old profiles and
clusters remain available for explicit, separately qualified data conversion.

Validate public startup, default packaging, remote-client rejection and retained data,
the Python product/container and workflow gates, frozen oracle integrity and full repository
checks. Native Preview lifecycle and Linux Work/browser evidence are retained with their
actual scope. New packaged inference must be recorded separately from offline replay.

## Implemented result

The default build omits the TS business Server. Frozen oracle integrity and SQL migration
checks pass. Full `npm run check` passes with19 successful builds (18 cached), and final
Desktop/Web scope tests preserve earlier role-selection/persistence regressions. npm10.9.9
clean installation and fresh Python/Web startup with real disposable PostgreSQL, Owner
login and the Vite proxy pass. macOS temporary fixture paths are canonicalized before the
unchanged no-follow model-storage checks.

Default macOS arm64 packaging and actual packaged PG/API restart/EOF/refusal checks pass.
One separately approved live packaged Kimi Task used4 receipts/8,845 tokens, passed independent
review, downloaded353 bytes and replayed its completed Workflow without Activities. See the
[public safe result](../../experiments/work-journey/evidence/desktop-packaged-inference.json).
The receiver required an additional identity-checked stop after the harness returned; all owned
processes and containers were then closed. No prior Task was resubmitted.

DSH implemented the Windows remote-install and two-lifetime DPAPI smoke scripts from the
approved public MIT input. Root reused the existing identity/progress helpers instead of
duplicating them, retained the installer/executable/ASAR checks, and added remote-only layout
checks. Native Windows execution belongs to this change's hosted CI; local macOS tests do not
claim Windows or Intel Mac native execution.
