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
