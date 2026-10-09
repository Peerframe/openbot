# OpenBot Python harness

The single active `openbot-agent-runtime` package lives here. It keeps the existing import name
`openbot_agent_runtime`, bounded Pydantic AI loop and optional Temporal composition. It proposes
work; Python control owns identity, authorization, routing, approvals, root budgets, facts and
publication. A Python process is not an OS sandbox. No second recovery or authority system is added.

## Start and check

Run from the repository root with Python 3.12+:

```sh
packages/harness/scripts/bootstrap.sh
npm run harness:check
packages/harness/scripts/check.sh -k catalog
npm run harness:wheel
```

Bootstrap installs locked external dependencies and the locally built wheel into `.venv`. Build
tools live separately in `.build-venv`. `check.sh` rebuilds and installs the wheel before testing,
so an old installed copy cannot silently qualify new source. `harness:wheel` creates a disposable
environment outside the checkout, installs runtime dependencies and the wheel with no source path,
then runs the deterministic example and checks its actual module path. It uses no model account.

`scripts/build.sh` is an offline wheel build after `scripts/bootstrap-build.sh`; its result is
`dist/openbot_agent_runtime-0.1.0-py3-none-any.whl`. Only the package, `py.typed`, metadata and license
are shipped. Development skills, tests, examples, control and build tools are not wheel resources.
The distribution is not published to PyPI. Editable installs are possible for exploration but do
not qualify a product payload or the installed-package gate.

| Environment | External lock | Local artifact |
| --- | --- | --- |
| Base runtime | `requirements-runtime.lock` | exact `distribution.lock` |
| Core tests | `requirements.lock` | same local wheel |
| Build / quality | `requirements-build.lock` / `requirements-quality.lock` | never runtime dependencies |
| Control Worker tests | `apps/server-python/requirements-worker.lock` | same local wheel |
| Product container / Desktop | `apps/server-python/requirements-product.lock` | same local wheel |

`verify_environment.py --profile dev|runtime|auto|build|quality` checks exact installed metadata.
`auto` selects only a whole dev/runtime profile. Locks remain bare exact pins; unknown entries,
drift, extra distributions or a missing local artifact fail. `pip`, `setuptools`, `wheel` retain the
existing interpreter-tooling exemption. The control verifier has separate `--worker`/`--product`
profiles; `derive-product-lock.py --check` proves the runtime closure from reviewed metadata.

## Public contribution surface

Import supported contracts, `execute_runtime`, `ToolCatalog`, `RunGuard`, `PortModel` and
`PortToolset` from the package root. See [contracts](src/openbot_agent_runtime/contracts.py) and
the actual [control adapter](../../apps/server-python/src/openbot_server/work_runtime_ports.py).
Internal worker/profile/wire helpers are not public extension points.

[read_note.py](examples/read_note.py) is a synthetic read-only extension through existing ports.
Its host admits one fixture note, emits one canonical result, derives model/UI summaries, and closes
the resource on success/error/cancellation. Unknown stays unknown, without retry or publication.
Run the example in the clean wheel gate; its [six tests](tests/test_extension_example.py) can run
with `scripts/check.sh -k extension_example`. It registers no new default product tool.

Optional `openbot_agent_runtime.temporal_agent.build_temporal_agent` is an explicit Worker API.
Normal package imports do not load Temporal. Activity factories, fixed tool IDs and replay identity
remain unchanged. An ordinary one-invocation pipe worker and a replayable Activity have different
lifetimes. Use `scripts/run-worker.py` with `python -I -u` for the former; the installed module is
resolved by the interpreter, not a source-path injection. Temporal tests need the locked Worker
environment and actual engine/replay checks in the [repository map](../../docs/REPOSITORY_MAP.md).

## Quality and evidence

```sh
packages/harness/scripts/bootstrap-quality.sh
packages/harness/scripts/quality.sh --core
# Only changes to optional Temporal or control adapters need the Worker type environment:
OPENBOT_CONTROL_PYTHON=python3.12 sh apps/server-python/scripts/bootstrap-worker.sh
packages/harness/scripts/quality.sh
```

One Ruff/mypy tool environment serves both profiles. `--core` uses the locked base test interpreter
and checks ordinary core/examples without Worker or database dependencies. The existing optional
Temporal guard is isolated in `temporal_guard.py`; that file and `temporal_agent.py` are checked
against the real SDK in the default `--all` profile, along with control factories, tool observations,
and the real read/web adapters. No missing-import suppression or replacement SDK stub is used.
The full Worker profile remains mandatory in CI and for changes to those integrations.
`check-boundaries.py` recursively scans declared source roots, excludes local environments/builds,
and rejects control/DB/provider imports and private consumer imports. The existing optional public
module is declared in `tool.openbot.public-modules`; each module's `__all__` owns its exports.
Exceptions match package-relative paths, so nested names cannot inherit them. New Python
modules have a 400-line review threshold, `contracts.py` 300; four existing lifecycle/wire modules
have individually explained fixed caps in pyproject. These are reviewed exceptions, not a refreshed
baseline for new violations. Test/format changes do not change authorization or budget semantics.

The [reuse evidence](RESEARCH.md#10-c2-installed-harness-and-contributor-tools-2026-09-27),
[local rules](AGENTS.md) and [repository map](../../docs/REPOSITORY_MAP.md) give integration status
and unverified platforms. Wheel success alone is not full product, native-platform or release qualification.
