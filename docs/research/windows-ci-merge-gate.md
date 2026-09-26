# Research: required cross-platform CI completion

- Status: Accepted for implementation
- Date: 2026-09-15
- Owner: OpenBot maintainers
- Related issue: PR #71 completion review; PR #72 follow-up
- Acceptance journey: the protected `check` context succeeds only after every required CI job succeeds, including Windows installation.
- Security boundary: read-only CI; no deployment, secrets, privileged workflow trigger, or failure exemption is added.

## Search evidence

Reviewed before implementation on 2026-09-15:

- GitHub queries: `actions runner needs result matrix failure skipped`; inspected runner issues [#2205](https://github.com/actions/runner/issues/2205), [#1540](https://github.com/actions/runner/issues/1540), and [#3041](https://github.com/actions/runner/issues/3041). Their skipped/cancelled-result reports support checking explicit results instead of assuming a dependent job must run or accepting every non-failure result.
- Primary sources: GitHub [required-status troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), [workflow dependencies](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds), and [needs context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#needs-context). Official documentation repository reviewed at [`90b9608d97646e302f555f3183e36708bad7a3fb`](https://github.com/github/docs/tree/90b9608d97646e302f555f3183e36708bad7a3fb).
- Existing records: `docs/OPEN_SOURCE_REUSE.md` cross-platform hosted CI and research gate entries, `docs/research/cross-platform-node-ci.md`, current workflow and security-workflow tests. The existing `check` covered only Linux validation and could finish before Windows.

## Candidate comparison

| Candidate | Exact version or commit | License / maintenance | Fit and decision |
| --- | --- | --- | --- |
| GitHub Actions native `needs`, `always()` and explicit result checks | GitHub docs `90b9608d97646e302f555f3183e36708bad7a3fb`; hosted service contract reviewed 2026-09-15 | GitHub documentation CC-BY-4.0 / example code MIT; maintained first-party service with public runner issue tracking | Selected standard. Keeps the existing protected context name and covers both matrices without a new action, token or package. |
| Existing pinned checkout and setup-node | checkout `3d3c42e5aac5ba805825da76410c181273ba90b1`; setup-node `820762786026740c76f36085b0efc47a31fe5020` | MIT; existing reviewed releases and upstream tests | Preserve every existing invocation. Aggregation needs neither checkout nor dependency installation. |
| Require every displayed matrix name separately in branch protection | Same GitHub status-check service contract | GitHub service terms | Viable, but couples repository settings to each matrix display name. Retain one stable aggregate required context instead. |

## Reuse decision

Use GitHub's native dependency graph. Rename the former `check` job to `validate`; add a final `check` depending on `security`, `validate`, `portable`, `windows-worker-host`, `database`, and `server-container`. These six job definitions represent nine existing runs. Set `if: always()` so a failed/skipped prerequisite cannot bypass the result check. Accept only `success` for each result; missing, failed, cancelled, skipped and unknown results fail. Matrix members retain `fail-fast: false` and no `continue-on-error`.

The narrow OpenBot gap is the list of required jobs and success-only shell assertion. The existing local workflow validator checks that every non-gate job is included, and tests execute the actual shell block with synthetic result values. No general workflow engine is introduced. A future job must join the dependency list; an upstream outage leaves CI unsuccessful. Branch protection configuration is separately verified against the live repository; this file does not claim that changing YAML changes repository settings.

## Source incorporation

No upstream source copied or substantially adapted; no new dependency or distribution notice. Existing action pins and read-only permissions remain unchanged.

## Verification plan

- Exercise the actual final shell command with all-success inputs and each required job failed, cancelled, skipped, missing or unknown.
- Reject a missing prerequisite, omitted new job, missing `always()`, and `continue-on-error` in local workflow validation.
- Run existing security workflow tests and the full repository check.
- Observe all current jobs and the final `check` at the exact PR head before merging; local tests alone do not prove hosted scheduling or Windows installation.
- Update English and Chinese contributor guidance. This change grants no new platform support level.

The existing Server container validator assumed its job was the last YAML job. Adding the final gate exposes that boundary error: the next job's `ubuntu-latest` is misread as a container runner. Bound extraction at the next peer job and test that peer content neither violates nor supplies the container contract; preserve all container restrictions.

## C3 scoped qualification (2026-09-27)

Reuse the native Actions `needs`/`always()` result contract and the existing npm workspace graph.
The upgrade's concrete gap is explicit non-applicability: a tested selector records every required
or non-applicable job from immutable PR base/head; the aggregate accepts only success for required
jobs and never hides failed/cancelled/missing results. Pushes to main, empty/unknown inputs,
selectors, locks and build configuration remain conservative. Local tracked/untracked changes are
separate inputs. No remote protection, permissions or release trigger changes are authorized.

The existing text checker freezes peer job order and action counts. Promote the already locked
[YAML 2.9.0](https://github.com/eemeli/yaml/tree/ddb21b04cb889722cec8f89dc1b67f19d62d7f7d)
(ISC, no dependencies) to an explicit development dependency and use its standard parser with
unique keys, no alias expansion and the default YAML 1.2 schema. Source, tests, license, release
and current issue index were reviewed; duplicate-key/alias and semantic mutation tests protect the
local use. Existing js-yaml is also maintained but offers no benefit over the already used YAML 2
API. Keeping hand-written substring extraction cannot reliably distinguish a property from a
comment or an adjacent job. No source is copied and this parser is not a product dependency.

Add one Python advisory scanner to the existing security lane: [pip-audit 2.10.1](https://github.com/pypa/pip-audit/tree/8894eb8cee033531a1fbd9f2fb160892531c14e3),
Apache-2.0. Reviewed PyPA release, `_cli.py`, CLI tests, dependency metadata, security model and
[open issue #874](https://github.com/pypa/pip-audit/issues/874) about unpublished distributions.
The selected released tool directly handles the existing exact requirements lock. OSV is a viable
advisory service, but adding another CLI or a custom query engine is unnecessary; npm audit remains
for npm only. Use a separate pinned tooling closure, `--disable-pip --no-deps --strict`, no `--fix`,
no ignores and no hidden return-code suppression. Audit every external product pin, compare report
coverage with the lock, and fail on missing/skipped dependencies or any advisory. The local wheel is
first-party source, not a fictitious PyPI package; its exact installation and dependency closure are
checked by C2. Advisory coverage does not establish native shared-library or malicious-package safety.

Primary references: [YAML options](https://eemeli.org/yaml/#parse-options),
[Actions needs](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#needs-context),
[pip-audit usage/security model](https://github.com/pypa/pip-audit/blob/v2.10.1/README.md).
No copied/adapted upstream implementation, new service authority or runtime dependency is introduced.
