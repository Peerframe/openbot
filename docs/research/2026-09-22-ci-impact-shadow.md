# Research: CI impact reporting in shadow mode

- Status: Accepted for implementation
- Date: 2026-09-22
- Owner: OpenBot maintainers
- Acceptance journey: a contributor sees the changed modules, Turbo-selected dependents and useful local validation commands in a PR summary while every existing CI check still runs.
- Security boundary: advisory local Git/Turbo analysis has no authority over CI gates. Fork PRs use the existing `pull_request` job, read-only repository permissions and checkout without persisted credentials. No token, secret, PR comment, remote cache or new external action is required. Classification failure recommends the full check.

## Search evidence

- Search date: 2026-09-22.
- GitHub queries: `repo:vercel/turborepo is:issue is:open affected`, `vercel/turborepo 2.10.12 affected dry run`, and the fixed release tree for `affected`, `scope`, `dry-run` and `LICENSE`.
- Primary documentation: [Turbo run](https://turborepo.dev/docs/reference/run), [GitHub pull request events and fork permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request), and [job summaries](https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions#adding-a-job-summary).
- Fixed upstream: [Turborepo 2.10.12](https://github.com/vercel/turborepo/releases/tag/v2.10.12), commit `53752d452049bdda47698354b16a83d7ce92ced0`, already pinned in OpenBot. Reviewed [MIT license](https://github.com/vercel/turborepo/blob/53752d452049bdda47698354b16a83d7ce92ced0/LICENSE), [change detector](https://github.com/vercel/turborepo/blob/53752d452049bdda47698354b16a83d7ce92ced0/crates/turborepo-scope/src/change_detector.rs), [affected integration tests](https://github.com/vercel/turborepo/blob/53752d452049bdda47698354b16a83d7ce92ced0/crates/turborepo/tests/affected_test.rs), and [reverse-dependency regression](https://github.com/vercel/turborepo/blob/53752d452049bdda47698354b16a83d7ce92ced0/crates/turborepo/tests/affected_rdeps_test.rs). The release includes dry-run JSON streaming and virtual-task affected fixes. Tests cover committed changes, explicit SCM base/head, diverged merge bases, global dependencies and task dependencies.
- Open issue [#14149](https://github.com/vercel/turborepo/issues/14149) reports over-selection with negated `globalDependencies`. OpenBot does not introduce those patterns; over-selection is safe for this advisory report. The upstream root-manifest regression test explicitly says root `package.json` is not always globally affecting when a lockfile exists: OpenBot therefore widens all manifests/build inputs independently.
- Existing records: `docs/OPEN_SOURCE_REUSE.md` lists reviewed GitHub contribution/CI and contributor startup surfaces. [Contributor startup research](2026-09-15-contributor-startup.md) already pins Turbo but does not review impact reporting. [Merge gate research](windows-ci-merge-gate.md) requires all jobs to succeed. This note completes the extension review before implementation.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Existing Turborepo affected dry-run | `2.10.12` / `53752d452049bdda47698354b16a83d7ce92ced0` | MIT | Released; source and affected/reverse-dependency tests inspected above | Existing npm workspace graph, read-only task selection, SCM base/head overrides; no task execution | Select released dependency through a thin adapter |
| GitHub workflow path filters | GitHub hosted workflow documentation checked 2026-09-22 | GitHub documentation/service terms | Maintained platform feature | File filters do not calculate workspace dependents; skipping required workflows changes merge semantics | Do not use for gate selection |
| New local workspace dependency graph | Not selected | OpenBot MIT | Would need separate graph/parser correctness tests | Duplicates the installed scheduler and can diverge from actual build behavior | Reject; the released dependency provides the graph |

## Reuse decision

- Selected option: thin adapter over the installed released dependency.
- Use the local Turbo CLI with `run typecheck test build --affected --dry=json` and explicit validated Git commits. Read package/task identities and directories from its JSON; never execute returned command strings. The adapter only produces a report and commands composed from bounded package names.
- Exact local gap: conservative OpenBot authority/build/unknown-path widening, Git base selection, bounded report rendering and local/CI output. Git rename detection is disabled so both old and new paths are inspected. A dirty checkout or a head different from the checked-out commit widens to full validation.
- Root documents and documents inside workspaces are never assumed harmless. Server/Node, shared contracts, storage, policy, provider SDK and native hosts widen to full because their authority/integration effects are not proved by an npm graph. Web, Desktop, individual Providers and small leaf workspace changes may receive a focused suggestion only when every changed path is classified.
- Upgrade/exit: keep the installed exact Turbo version. JSON incompatibility, missing history/CLI, malformed paths, timeouts, excessive output or unrecognized inputs must produce a full recommendation. Before using impact results to skip CI, separately measure shadow output against full CI and review missed-edge evidence; this change gives no such permission.

## Source incorporation

- Source copied or substantially adapted: no.
- Files: `scripts/report-ci-impact.mjs`, its fixture tests, a report-only step in the existing validate job, and bilingual contributor documentation.
- Required notices: no copied-source notice; installed Turbo retains its MIT license.

## Verification plan

- Fixture tests: leaf change and dependent selection, cross-workspace/deleted paths, security/shared/config/lock/documentation/unknown changes, missing or malformed history/JSON, command/path injection, dirty checkout and no changes.
- Exercise the actual pinned Turbo binary against this repository and a disposable Git/npm-workspace fixture. Verify the report never runs package task commands and recommendations preserve task dependency ordering.
- Run existing workflow-security tests to prove the full gate remains unchanged; add fixtures that require the advisory step and reject conditions driven by its output.
- Run documentation, formatting/lint and repository checks at integration.
- Scope: hosted Linux report generation and local Node/Git/Turbo verification; no reduction in checks and no new platform-support claim.

## Unresolved questions

- Accurate speedup and false-negative rates require future measured shadow runs. Neither is claimed by this implementation.
