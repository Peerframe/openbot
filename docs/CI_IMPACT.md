# CI impact reporting

[简体中文](CI_IMPACT.zh-CN.md)

CI now adds an advisory impact report to the existing validation job summary. Every existing
security, repository, platform, native Worker, database and container check still runs and remains
required. The report is a way to choose earlier local feedback; it cannot approve a change or skip
checks. No speedup or detection-accuracy claim has been measured yet.

## Run locally

After `npm ci`, commit the changes you want to compare, then run:

```sh
node scripts/report-ci-impact.mjs --base origin/main
node scripts/report-ci-impact.mjs --base HEAD~1 --json
```

The default head is the checked-out `HEAD`. `--head` is accepted only when it resolves to that same
commit, because Turbo reads the current checkout's workspace graph. A dirty checkout recommends
`npm run check`: this first version deliberately reports committed ranges and does not claim a
complete working-tree analysis. Local output is Markdown; `--json` emits the same advisory data as
JSON. A missing ref, shallow history, missing Turbo or unsupported output also recommends full
validation. The report never fetches Git history or installs packages on your behalf.

In CI, a PR compares its event's base SHA with the checked-out merge commit, using their merge base.
A push uses its previous SHA. The existing checkout retains complete history. An initial push with
no previous commit or an invalid event falls back to the full recommendation. Fork PRs use the same
`pull_request` flow with read-only permissions, no persisted checkout credentials, and no new
secrets, external actions, comment API or remote cache.

## What the report means

| Scope | Meaning | Suggested local validation |
| --- | --- | --- |
| `focused` | Every changed path belongs to a reviewed leaf source area; Turbo identifies its workspace, dependents and required dependency builds | Root lint plus a Turbo `typecheck test build` command with the reported workspace filters |
| `full` | A broad-impact path, unknown path or analysis failure prevents a narrower recommendation | `npm run check` |
| `unchanged` | The selected committed range has no changes and Turbo agrees | `npm run check` remains the required handoff; no check is skipped |

The report reuses the installed, exact Turborepo version's `--affected --dry=json` behavior. It does
not maintain a second workspace graph, execute package scripts or trust command strings returned
by Turbo. The suggested command includes dependency builds and limits concurrency to two.

Only source files in the existing Web, Desktop, individual Provider, logging, Provider conformance
runner and office-plugin workspaces can receive a focused suggestion. This does not expand the
deferred office plugin. Even there, authority-related filenames widen the result. Unknown paths,
new workspaces, deleted workspaces and incomplete Turbo identities widen to full.

Server, Node, native Worker Hosts, protocol/domain contracts, policy, database/migrations,
configuration, Provider SDK and credential protection always require full validation. Dependency
manifests, lockfiles, build/tool configuration, CI, scripts and deployment inputs also widen to
full. Documentation is not classified as automatically safe: it may change support claims or
contracts. This conservative policy is an advisory starting point, not a proof that every
cross-workspace effect is encoded in npm dependencies.

## Verify and evolve

```sh
node --test scripts/report-ci-impact.test.mjs scripts/check-security-workflow.test.mjs
node scripts/check-security-workflow.mjs
npm run check
```

Fixtures include the actual pinned Turbo in a disposable Git/npm workspace, reverse dependencies,
rename/deletion handling, unsafe identities, event/base selection, dirty and missing history,
missing tools and conservative broad-impact classifications. Native platform and real-service
coverage continues to come from the unchanged CI jobs, not from these fixtures.

Before any future proposal uses the report to omit work, collect shadow reports alongside full CI
results, investigate missing dependency edges and measure actual job durations. That requires a
separate reviewed policy change. The current workflow does not expose report outputs to job
conditions or matrices.

See the [upstream research and fixed version](research/2026-09-22-ci-impact-shadow.md).
