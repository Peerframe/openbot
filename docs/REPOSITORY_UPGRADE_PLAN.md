# Repository upgrade — current handoff

English canonical; 中文摘要见文末。This is the single C1→C2→C3 task record.
[MIGRATION_HANDOFF](MIGRATION_HANDOFF.md) remains historical migration evidence.

## Baseline, ownership and current state

- Original checkout: `/Users/yxflc/Project/openbot`, branch `feat/cross-platform-employees`,
  HEAD `9cc73c9e78451e572f57d142d6b9caf62ccb78e2`. Its existing root AGENTS edit,
  untracked Chinese AGENTS, PNG and `output/` are user-owned and untouched.
- Implementation checkout: `/Users/yxflc/.codex/worktrees/repository-c1/openbot`,
  branch `codex/repository-c1`. Actual main was independently verified as
  `82f76059b97521065d88acb069b595af8a13ea54`; this is the base, not a reset to a report pin.
  Base [CI 36241261445](https://github.com/Peerframe/openbot/actions/runs/36241261445) passed;
  that is not candidate CI evidence.
- Local checkpoints: C1 `a770d870e81cb2295a1c4ed76da7796997c67716`; pure C2 move
  `17fb2f4`; C2 package/consumers `b6e623a`; C2 final evidence/quality `7399e11`.
  Resolve the current result with `git rev-parse HEAD` and `git status --short`.
- User requested continued completion after C1. C1/C2 and the C3 local implementation are accepted; **final hosted CI is pending**.
  One parent owns all integration files. C3 implementation ends at `074f94d95e7066e7d04c657e3e65c8d1eb463df3`; later handoff-only edits
  reuse that executed evidence. The final branch HEAD is the review candidate.
  On 2026-09-27 the user explicitly authorized branch push, then draft PR creation and CI.
  The branch was pushed and [draft PR #100](https://github.com/Peerframe/openbot/pull/100) is open
  against main. Final candidate hosted CI remains a completion gate. Merge, publication, paid
  model calls, production mutation and remote protection changes remain unauthorized.
- Separate acceptance checkout: `/Users/yxflc/.codex/worktrees/contributor-acceptance/openbot`,
  based on `7399e11`. All three contributor writers finished. All integration checks and artifact writers also finished.
  Demo patches remain isolated and must not be merged automatically. Its copy of this handoff
  records outgoing ownership so each new session can continue without oral project context.

## Reused baseline and preserved boundaries

Python was already the product control plane; TS Server retirement/oracle protection, Temporal,
TS/React, thin Electron and necessary Node parsers remain. The upgrade reuses those decisions,
not another engine/language survey. Identity, authorization, routing, approvals, root budget,
publication and audit stay in control. No second loop, ledger, recovery or product skill system.
The user's original working tree, SQL history and frozen oracle remain intact.

## C1 accepted evidence

Root plus six local rule scopes, four on-demand development skills, the existing maps,
contribution/research templates and design index now route to actual owners/consumers/checks.
Ordinary fixes cite valid decisions; new dependency versions, public contracts, authority and
persistence boundaries retain targeted evidence. The research shortcut rejects mixed dependencies,
authority owners, imports and unknown paths; it does not prove semantics by filename.

- Actual Codex native app-server `skills/list` discovered all four skills in root/Web/core/protocol.
  Four ephemeral `thread/start` calls returned correct root/local `instructionSources`; no
  `turn/start` or model call. A fresh-context reader independently located UI, core and wire tasks.
- Reader findings corrected the App-toolbar menu parent, stale TS defaults and contract references.
- `docs:check`: 4 tests, 535 Markdown files. `research:check`: 22 tests. Four skill metadata checks.
  Catalog 51 passed, 1 optional Temporal module skipped; real TS/Python wire comparison 48 cases;
  focused UI/API 9 passed. Final full `npm run check` passed.
- C1 first full Turbo groups: typecheck 31/31 (10 cached), test 31/31 (18 cached), build 19/19
  (14 cached). Final unchanged groups fully cached; root Node 196 passed/2 platform skips and
  browser Python 35 passed actually reran. Never count replayed cached logs as fresh tests.
- Logs: `/private/tmp/openbot-c1-{check,check-final,core-check}.log` and discovery JSON.
  These counts are historical C1 evidence, not claims about later changes.

## C2 accepted implementation and evidence

The one active core is `packages/harness/src/openbot_agent_runtime` (12 modules). The import name,
loop/guard behavior, wire and Temporal names are preserved. Hatchling builds an explicitly selected,
typed wheel; public exports, lazy optional Temporal import, AST boundaries, Ruff and mypy protect
it. Four legacy file-size exceptions have specific reasons; new modules use 400/300-line review
thresholds without refreshing away violations. All actual consumers install the wheel.

| Consumer | Current contract |
| --- | --- |
| Ordinary process | `runtime_executor.py` / `run-worker.py`; one invocation, bounded pipes and teardown |
| Product/Temporal | `work_runtime_ports.py`, `work_product_runtime.py`, `work_worker.py`; control factories and replay IDs unchanged |
| Dev | `serve.py`, `dispatch-work.py`, installed Worker environment; no core source PYTHONPATH |
| Container/Desktop | Same wheel in product environment; keep Node parsers/migrations, exclude build tools and source core |
| Extension | `examples/read_note.py`; canonical/model/UI projections, declined/error/unknown/cancel/revocation cleanup |
| HTTP contract | Actual FastAPI Work GET response → generated TS → real `work-api` consumer with runtime Zod |

| C2 executed gate | Result / limit |
| --- | --- |
| Outside-checkout wheel | isolated `-I`, site-packages, 19 exact runtime distributions; no DB/Temporal/pytest; synthetic tool succeeds |
| Core | 436 passed / 1 optional Temporal module skipped; extension 6 passed; later public-boundary 13 passed |
| Quality | Ruff/format and mypy passed, 18 typed core/example/real-consumer/contract-lock files |
| Work contract | 11 real Python HTTP/DTO → TS semantic cases; freshness and Web typecheck passed |
| PostgreSQL control | 836 passed / 2 skipped in 105.89s |
| Worker | 1526 passed / 1 skipped in 540.08s; original 300s/600s timeouts retained |
| Cross-language | identity 129, task/usage 60, runtime 48, commands 34, execution 40 agreed |
| Actual Temporal | owned PostgreSQL + mTLS engine, concurrent Runs, isolated cancel accounting/artifacts and real offline replay; scripted ports, no paid model |
| arm64 container | actual build/smoke: Owner login, built Web, docx/pdf/OCR, restart keys/files, 45 migrations, refusal/SIGTERM cleanup |
| macOS arm64 staged preview | actual install/start/login/restart, parent EOF, config/symlink refusal cleanup; synthetic encryption, no Keychain claim |
| Same implementation | all 12 module hashes matched source, core/Worker installs, final preview and container |
| Repository | full `npm run check` exit 0; final build 19/19, 18 cached; fixed-diff read-only reviewer found no confirmed regression |

Logs: `/private/tmp/openbot-c2-{control-final,check,desktop-final-smoke,container-final-smoke,contracts-final,wheel-final}.log`.
Source-hash evidence: `/private/tmp/openbot-c2-{source,container}-hashes.json`.
C2 closures: runtime 18 external + own distribution, dev 23 + own, Worker 63 + own, product 58 + own;
base control 52. C3's Soup Sieve security update requires fresh product evidence below.

## C3 check duties and artifact ownership

| Entry | Inputs/environment | Consumer and failure class | Output writer / order |
| --- | --- | --- | --- |
| `ci:scope` | actual immutable PR base/head/merge base, or separately local tracked/untracked; npm lock graph | Actions + affected validation; unknown/config/contract/lock scope expands, missing ancestry fails | scope job alone writes plan; same input recomputed by validate |
| `check:affected` / `check` | selected workspaces or complete repository; Node/npm identity, graph/config/env | contributor/validate; root gates, lint/type/test/build failures | existing Turbo dependencies; type/test/build phases sequential; full check unchanged |
| `ci:check` + `security:config-check` | fixed changes, real Git CLI, YAML, actual Turbo dry-run and empty Vitest | CI policy; canceled/missing/skipped required result, bad pins/permissions, swallowed failure | temporary fixtures only; no remote settings |
| `security` | full Git history, npm production lock, Python product lock; read-only advisory network | final check; credentials, advisory, missing/duplicate/skipped report coverage | isolated exact pip-audit tool env; private scan reports cleaned, no finding upload |
| `harness` | locked core/Worker/quality environments; real Python DTO/generator/Web consumer | installed API and contract lane; package/import/type/freshness/semantic failures | wheel producer precedes each install; same version; isolated tool venvs |
| `python-runtime` | installed wheel, base/Worker closures, owned PostgreSQL + synthetic HTTP/model fixtures | persisted product compatibility | fixture owner creates and cleans DB; no product data or paid model |
| `temporal-qualification`, browser lanes | actual engine, mTLS, PostgreSQL, Node/browser and owned egress fixtures | durability/replay/recovery/network boundaries | lane-owned containers/processes; traps/finally cleanup, no shared checkout |
| `portable`, Windows Worker | affected retained Node/Desktop/native host and platform runners | real bootstrap, transport, native packaging/platform contracts | Turbo builds once before native staging/package; companion before Mac package; build-only Windows host |
| product container | Docker runtime-product, exact Python/Node locks, two native architectures | actual install/start/restart/refusal/cleanup | multi-stage wheel and Web producers; isolated image + smoke-owned DB |
| Python Desktop preview | macOS arm64, built Desktop/parser dependencies, exact product closure | stage and packaged-resource startup/refusal/cleanup | stage → smoke → package → packaged smoke; never concurrent staging writers |
| synthetic migration | same-commit reusable workflow and disposable assets | migration/recovery compatibility | fixture owner; no production conversion |
| `check` / release workflow | explicit selected jobs + actual `needs`; separate tag-only release inputs | only required success satisfies aggregate; PR green is not release qualification | aggregate owns status; releases independently compare bytes, smoke, attest and retain artifacts |

C3 removed only the proven duplicate macOS release test invocation; its test remains in
`worker-host:macos:check`. Workflow checks now parse YAML and assert necessary properties, not peer
job order, step names or incidental counts. Immutable pins, minimal authority, required execution
order and artifact provenance remain checked. Scope fixtures passed before conditional lanes were
enabled. Security/validate always run; main pushes stay full. New/unknown contracts, locks, build
and CI inputs remain conservative. Scope follows transitive npm consumers and explicit Python/
Desktop edges; it is not another maintained dependency graph.

No-test workspaces no longer return Vitest success for empty collection; coverage is attributed to
actual consumers. Turbo hashes npm/Node/OS/architecture identity through npm's user agent, declared
runtime environment, source/lock graph and root script/generator inputs. `npm run`/`npm exec -- turbo`
are qualification entrypoints; raw Turbo without that identity is not. CI caches npm downloads,
not prior successful tests. Native qualification and uncached root/Python probes remain separate.

### C3 final local evidence (2026-09-27)

| Gate | Actual result / evidence boundary |
| --- | --- |
| Final `npm run check` at `074f94d` | exit 0; root Node 208 passed / 2 platform skips; browser Python 35 passed; 61.42s wall, 167.04s user + 26.77s system CPU |
| Turbo distinction | typecheck 31/31, 0 cached; test group 26/26, 12 cached; build 19/19, 12 cached. Web 473, Desktop 402/3 skips, Node Vitest 94/3 skips + Node test runner 53 actually executed; other package counts remain in the log |
| CI selection/cache/audit fixtures | 19 passed, including real Git committed/local separation, transitive/dynamic/contract/browser inputs, every required failure/cancel/missing/skip, environment hash changes and an actual empty Vitest failure |
| Workflow policy | `security:config-check`: 25 passed; YAML peer/step renaming accepted, essential sources/permissions/native/release/aggregate behavior enforced |
| Rules/docs/research | 4 discovery/routing tests, 535 Markdown files, 22 research tests; local non-PR invocation explicitly does not validate a remote PR body |
| Actual selection | final upgrade selects all 12 qualifications; clean candidate plus one owned README newline selected focused validation + security, passed in 8.73s (10.05s user, 2.81s system); exact README bytes restored |
| Cold contract | fresh Git snapshot had no node_modules/dist; direct old-style runner failed to resolve `@openbot/domain` and collected no tests. Canonical `contracts:test` built both dependencies without cache, then 11 cases passed; actual OpenAPI freshness also passed |
| Python quality | one existing Ruff/format + mypy entry now also checks the new audit verifier: 22 formatted files, 19 typed files; exact 7-tool environment and 12-module boundary passed |
| Dependency security | all 58 external production Python pins audited, no known advisory/skips; npm production audit found 0 vulnerabilities. Soup Sieve 2.9.2 metadata, all locks and complete MIT notices agree |
| Candidate Git history | pinned TruffleHog, network/verification disabled, full local candidate ancestor history: 13 exact pre-reviewed historical fixtures, no unreviewed finding. No new exception; private raw reports removed. This is not a scan of every remote ref |
| Fresh control/Worker | owned PostgreSQL base 836 passed / 2 skipped in 105.13s; Worker 1526 passed / 1 skipped in 524.53s. Same original 300s/600s limits; cross-language identity 129, task 60, wire 48, command 34 and execution 40 comparisons passed |
| HTML extraction | 54 public-source tests passed against Soup Sieve 2.9.2; C2 actual mTLS/replay evidence reused because engine/core behavior is unchanged |
| Final arm64 container | `openbot-c3-product:local`: Owner HTTP, built Web, docx/pdf/OCR, restart keys/files, 45 migrations, preflight refusal, SIGTERM/owned-resource cleanup all passed |
| Actual macOS arm64 app | staged runtime and packaged `apps/desktop/out/python-product/OpenBot Python Preview-darwin-arm64/OpenBot Python Preview.app` both passed Python API/PostgreSQL start/login/restart, parent EOF, unsafe/symlink/config refusal and cleanup; unsigned preview, synthetic encryption, no native Keychain claim |
| Same installed core | all 12 source-module hashes match Worker, staged Desktop, actual packaged Desktop and container; every consumer reports harness 0.1.0 and Soup Sieve 2.9.2 |

The new audit initially found six Soup Sieve 2.8.3 records representing four unique advisories.
Targeted review and the narrow 2.9.2 update fixed the real gate; no ignored advisory. A stale
pyproject pin was found during final closure checking; metadata/notices and a consistency check
were added before final packaging. The first concurrent Worker run hit its unchanged timeout;
sequential rerun passed. Existing bounded Desktop downloads timed out once, then the same producer
succeeded. A bare Git scan fixture was rejected; the same ordinary-clone layout as CI passed.
These failed attempts are not counted as passes or hidden by larger limits.

A read-only review of `7399e11..46ddb3e` found three real gaps: cold contract dependencies,
missing contract-consumer propagation, and skipped browser boundary regressions. Fixes at
`34a9394` / `5b09c33` were incrementally reviewed and tested, including the actual cold failure→pass
above. `6389bc4` added audit type coverage; `074f94d` preserves npm cache identity only in the
control fixture's build prerequisite (the passed Worker environment is unchanged). Full check then
passed at that final implementation revision. No later code change is hidden in handoff evidence.

### Three completed fresh-session contributions

All demos stay in the detached acceptance checkout; eleven dirty files are owned and described in
its copy of this same handoff. No demo was committed or merged into the integration branch.

| New context | Entry and useful feedback | Actual acceptance / cost |
| --- | --- | --- |
| UI | located App toolbar/member menu/design rules; first ArrowDown regression 4/7 failed | focused 31 passed; actual Python + owned PG page at 1440×900 and 390×844 checked keyboard/empty/disabled/failure/recovery/bounds. Full check passed; Web 478 and Desktop 402/3 skips fresh. 35 repo paths + one external skill, 15m45s |
| Python | read the prior handoff and local core contract; initial 3 failed/20 passed | installed-wheel example 23 passed, 1 optional Temporal module collection skip, 434 deselected; quality passed. Full check passed with Turbo groups cached; prior UI hashes unchanged. 24 repo paths, 7m07s |
| Python→TS | independently followed DTO→HTTP→generator→real Web consumer; initial 5 failed/17 passed | 32 actual FastAPI TestClient/DTO→Web cases, 22 Web API tests, generation/freshness/type/quality passed. Full check passed; Web 493 and Desktop 402/3 skips fresh, remaining cache labeled. Four prior demo hashes unchanged. 35 repo paths, 7m42s |

This proves two handoffs can continue from repository rules and one short current summary without
oral file answers. The contract task used a synthetic Writer behind the actual HTTP route, not a
production DB. UI synthetic services/browser/data were cleaned; all three writers stopped. Reading
counts include partial reads and exclude search-only hits. These are three usability samples, not
statistical performance gains. Real tokens, model price, active labor and hosted CI compute/wall time
are unavailable; local wall/CPU times above are not CI cost estimates or comparable-workload savings.

### Logs, limits and next authorized action

- `/private/tmp/openbot-c3-check-result.log`, `openbot-c3-control-final.log`,
  `openbot-c3-{ci-final,security-final,quality,python-audit-fixed,npm-audit,credential-summary}.log`.
- `/private/tmp/openbot-c3-cold-contract-{red,green,freshness}.log`,
  `openbot-c3-prose-affected.log`, `openbot-c3-upgrade-scope.json`.
- `/private/tmp/openbot-c3-{container-smoke-final,desktop-staged-smoke,desktop-packaged-smoke}.log`
  and matching build/package logs; four `openbot-c3-*-hashes.json` files retain installed proof.
- Contributor logs use `/private/tmp/openbot-contributor-{python,contract}-*`; actual UI viewport
  evidence is `/private/tmp/openbot-contributor-1440.png` and `openbot-contributor-390.png`.

No local C1→C2 entry blocker remains; local C2/C3 implementation and bounded acceptance are done.
**The overall upgrade is not closed:** the authorized branch push and draft PR are complete;
[PR #100](https://github.com/Peerframe/openbot/pull/100) is running hosted CI. Its actual remote
research body passed the existing local PR-event validator. Wait for the final candidate hosted
`check`, not base CI or local aggregate fixtures; any newer push supersedes an older run.
Native Windows/Linux lanes, both hosted container architectures and complete hosted recovery/
migration suites remain pending at this checkpoint. Read their final results from the PR. Native Keychain,
formal signing/notarization, user installation and release were outside this local candidate scope.

All owned test services, temporary DBs, cold/scan fixtures and writers finished or were cleaned.
Keep the unsigned generated preview for review, the isolated demos and the original user assets.
The integration working tree is committed and clean after this handoff-only checkpoint; always
recheck actual status before the next write. No paid model, production data or remote protection
was touched. Do not rerun unchanged full suites solely for this status record.

## 中文当前摘要

已完成 C1、C2 和 C3 的本地实施与验收；原 checkout 与用户修改保留。统一开发入口、正式 harness
wheel/真实消费者、扩展与契约链、按影响选择的 CI 和失败关闭汇总均已落实。三条新会话贡献及两次
真实交接通过，演示补丁留在独立 checkout。完整门禁、真实 PostgreSQL/Worker、最终容器与桌面包
均通过；新安全门发现的依赖漏洞已修复，未靠忽略或延长时限过关。缓存、跳过、合成与真实范围如上。
用户已明确授权推送、创建草稿 PR 和运行 CI；分支已推送，草稿 PR #100 已创建，真实 PR 正文通过
研究门禁校验。最终候选云端 CI 正在执行，须以 PR 上最新提交的最终 check 为准；本地证据不能替代
云端/全部平台结果。尚未授权或执行合并、发布、替换用户安装、付费模型调用或生产数据操作。
