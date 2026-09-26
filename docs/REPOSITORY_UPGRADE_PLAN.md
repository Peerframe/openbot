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
- User requested continued completion after C1. C1/C2 are locally accepted; **C3 is active**.
  One parent owns all integration files. C3 is being preserved as a local review checkpoint; follow-up evidence remains with this parent.
  No push, merge, publication, paid model call, production mutation or remote protection change
  is authorized. Final candidate hosted CI remains a completion gate.
- Separate acceptance checkout: `/Users/yxflc/.codex/worktrees/contributor-acceptance/openbot`,
  based on `7399e11`. All three contributor writers finished; only the integration parent is active.
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

### C3 actual evidence and remaining work

- Selection + aggregate + audit + release focused set: 21 passed. Structured workflow + real cache
  identity/empty-test set: 24 passed. No job may satisfy requirements with an unexpected skip.
- Actual new audit first found six Soup Sieve 2.8.3 records (four distinct advisories). Targeted
  review chose 2.9.2; base/Worker/product pins agree. The new audit actually covered all 58 product
  external pins with no known advisory or skip. No vulnerability ignore list was added.
- Fresh contributor UI: 35 repository files + one skill read; 15m45s. First failure was closed
  `details` after ArrowDown. Focused 31 passed, real Python/owned PG page at 1440×900 and 390×844
  checked keyboard/empty/disabled/failure/recovery/bounds. Full check passed; Web 478 and Desktop
  402 passed/3 skipped were fresh. Services, browser and synthetic data were cleaned.
- New Python session read the same brief handoff and preserved UI hashes: 24 repository files,
  7m07s. Initial 3 failed/20 passed; final 23 passed, 1 optional Temporal collection skip and
  434 deselected. Actual installed-wheel path and quality 18 files passed; complete npm check
  passed with Turbo groups fully cached. Example demo only, no core loop or authority change.
- Contract session independently completed the third task: 35 repository paths, 7m42s; first
  5 failed/17 passed, final 32 actual FastAPI TestClient/DTO→Web cases and 22 Web API tests passed.
  Generation/freshness, Web typecheck, quality and full check passed; Web 493 and Desktop 402/3
  skipped were fresh; other cached results stay labeled. All four previous demo hashes unchanged.
  This is synthetic Writer HTTP-boundary evidence, not DB/production qualification. No real
  Token/price metrics are available; the samples establish usable paths, not percentage gains.
- Full repository check passed: typecheck 31/31 (0 cached), test 26/26 (12 cached), build 19/19
  (12 cached). Public-source extraction 54 passed; npm production audit 0 vulnerabilities.
  Manifest/lock consistency and CI checks passed after fixing a stale pyproject pin and notices.
- C3 first refreshed base control: 836 passed/2 skipped in 104.06s; concurrent Worker reached
  its unchanged 600s limit. Diagnostic verbosity/traceback were added, without increasing limits;
  rerun sequentially. Desktop Node-archive download also hit its existing network timeout.
  First refreshed arm64 container smoke passed; rebuild its final metadata/notices before reuse.
- Pending local integration: final review and follow-up gates, sequential refreshed Worker,
  container and staged/packaged Desktop smoke after the dependency update; final scope comparison
  and read-only fixed-diff review. Native non-Mac targets and final-head hosted CI are not claimed.

Logs live under `/private/tmp/openbot-c3-*`; they are not committed. Keep this section current,
not append a second status record. After all local acceptance, commit a reviewable C3 checkpoint;
final hosted CI requires separately authorized push/PR. No automatic merge/release follows.

## 中文当前摘要

原 checkout 与用户修改保留。C1 和 C2 已本地验收；C3 正在完成 CI 选择/汇总、真实安全闭包、
缓存/构建职责及三条新会话贡献路径。新安全门发现的 Soup Sieve 漏洞已针对性升级并重新审计通过。
UI、Python 两次独立贡献及真实交接已完成，契约会话及两次换会话交接也已完成；无关演示补丁留在独立 checkout。
安装物与最终整合仍在验证，尚未推送、合并、发布或验证最终候选云端 CI；不将本地成功冒充远程资格。
