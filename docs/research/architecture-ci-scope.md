# Research: qualify the Python product explicitly in CI

- Status: Accepted for CI implementation; new hosted jobs must pass before acceptance
- Date: 2026-09-26
- Related issue: PR #96
- Acceptance journey: the protected `check` waits for the actual Python control/Worker tests,
  direct product containers, packaged macOS arm64 Python Preview lifecycle, and synthetic migration.
- Security boundary: disposable CI data only; no deployment, default-backend switch, private model
  account, remote host, signing identity or installed user application.

## Search evidence

Reviewed the execution graph at `e2522b383517bc1d3af169f24128270a3c714cd0`, not only job names:

| Existing check | Actual subject | Meaning for the rewritten product |
| --- | --- | --- |
| `validate` / root `npm run check` | Repository guards, retained clients/packages and the still-present TS Server | Repository regression coverage; not a complete Python product gate |
| `portable` | Shared client tests plus default Desktop packaging, which selects `apps/server` | Retained-client and legacy-release compatibility; not Python Desktop acceptance |
| `database` | Shared SQL and legacy TS business-service integration | Retained regression evidence; not proof of Python business behavior |
| Legacy and Python-child container smoke | Both launch `apps/server/dist/index.js` | Legacy bridge compatibility; the child runtime alone is not the new Server |
| Direct `Dockerfile.product` smoke | Actual Python product entry on native Linux amd64/arm64 | New product HTTP, parser, migration and process lifecycle coverage |
| `python-runtime` | Base/Worker Python suites, owned PostgreSQL, public HTTP and mTLS Temporal journeys | New control/Worker behavior plus explicitly frozen compatibility comparisons |
| `s7-migration.yml` | Synthetic histories and paired restores using a frozen test-only reader | Useful migration evidence, but previously omitted from protected `check` |

The separate `--python-product` preparation/packaging and `smoke-python-product.mjs` already exist,
but no CI job selects them. The normal Desktop package command cannot substitute for them.

Rechecked reuse-ledger entries for CI completion, Desktop Python packaging, direct product
containers and the frozen Server oracle; the exact implementations and pins above are retained.
Primary references: [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
and [job dependencies](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds).
GitHub query `workflow_call path:.github/workflows language:YAML` in `actions/starter-workflows`
returned no matching reusable candidate. The existing repository workflow already implements
the required migration checks; a second implementation is unnecessary.

## Candidate comparison

| Candidate | Exact release or commit | License / maintenance | Decision |
| --- | --- | --- | --- |
| GitHub `workflow_call` plus existing S7 workflow | Same caller commit; existing checkout `3d3c42e`, setup-node `8207627`, upload-artifact `043fb46` full pins retained | Official Actions API; existing native hosted S7 evidence and tests | Reuse; makes the migration result a direct required dependency without duplicate runs |
| Existing Python Preview and container entry points | OpenBot `e2522b3`; CPython3.12.13, Node24.21.0, Electron44.3.0 and existing exact Worker lock | MIT OpenBot adapters; upstream license/pin review in the linked reuse records | Run unchanged entry points in dedicated named product jobs |
| Keep treating the default Desktop package as Python evidence | Same checkout | Tests a different selected backend | Reject |
| Replace tests with mocks, delete legacy checks, or add private remote/model dependencies | No candidate | Would discard coverage or prevent ordinary contributors from reproducing CI | Reject |

## Reuse decision

1. Separate the existing direct product-container steps from legacy container compatibility so
   their independent results identify the actual backend under test.
2. Add macOS arm64 Python Preview qualification. Build retained Desktop/DB/parser workspaces,
   stage the exact Python distribution, test the staged runtime, package with both explicit
   Preview and Python flags, and repeat the real lifecycle smoke against packaged resources.
   Retain a mode-preserving archive and synthetic summaries. Do not use default `prepare:native`.
3. Call the existing S7 workflow at the same commit through `workflow_call`, also retaining a
   manual entry. Make it required by `check`; stop duplicate automatic standalone executions.
4. Label legacy/client jobs accurately. Keep all existing checks required while the documented
   default/retirement boundary still applies. This change does not silently retire the TS Server.
5. Extend the existing gate guard to cover the new required jobs and product selection. Exercise
   its actual shell on success, failure, cancellation, skips and missing results.

The frozen TS oracle only checks retained historical contracts; it is not the authority for new
Temporal/product semantics. A product-specific assertion must follow the current reviewed
contract. New support claims require their own executed product evidence.

## Source incorporation

No upstream source copied, no dependency added, no product code or existing runtime pin changed.
Move existing OpenBot workflow steps without weakening their assertions; MIT notice is retained.

## Verification plan and limits

Run the existing workflow guard and real shell negatives, check the retained build graph excludes
the TS Server, run `npm run check`, then run the entire hosted workflow on the pushed head.
Maintain [the Chinese scope record](architecture-ci-scope.zh-CN.md).

The macOS smoke uses synthetic bootstrap encryption, not Keychain or GUI automation. No Python
Desktop distribution on Windows/Linux is newly qualified. Product command/runsc/browser handover,
private remote replay, live migration and release/signing remain separately bounded, incomplete
acceptance items. Current npm advisory scanning does not imply Python advisory coverage; exact
Python locks and `pip check` establish a different property. None of these gaps can be closed by
making legacy jobs green.
