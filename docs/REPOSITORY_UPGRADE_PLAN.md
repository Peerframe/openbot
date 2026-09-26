# Repository upgrade — current handoff

English canonical; 中文摘要见文末。This is the only C1→C2→C3 task record. Historical
[MIGRATION_HANDOFF](MIGRATION_HANDOFF.md) is evidence for earlier delivery, not this task's status.

## Baseline and ownership

- Date: 2026-09-27. Initial baseline + C1 accepted locally. The user requested continued
  completion; C2 is locally accepted; C3 is active. Publishing/paid/production restrictions remain.
- Original checkout: `/Users/yxflc/Project/openbot`, `feat/cross-platform-employees`,
  `9cc73c9e78451e572f57d142d6b9caf62ccb78e2`; this is an older TS branch.
- Pre-existing changes: modified root AGENTS, untracked Chinese AGENTS, user PNG and `output/`.
  Preserve them. The user's rule edits are incorporated here without touching that checkout.
- C1 checkout: `/Users/yxflc/.codex/worktrees/repository-c1/openbot`, `codex/repository-c1`.
  Base: `82f76059b97521065d88acb069b595af8a13ea54`; the C1 result is the local branch HEAD, not pushed or merged.
  GitHub API independently confirmed that exact main on this date; no reset to the report's pin.
- Main [CI 36241261445](https://github.com/Peerframe/openbot/actions/runs/36241261445) passed on the base;
  Dependabot Updates failed separately. Neither result validates this C1 diff.
- One implementation owner: current Codex task, all C1 files. Any acceptance reviewer is read-only.
  C2 source/package migration is authorized. No product data, remote protection, release or paid-model work is authorized.

## Reuse and finite scope

| Item | Baseline evidence / disposition |
| --- | --- |
| Python product default | Already present in `scripts/dev-python.mjs`, product Compose and Python README; reuse |
| TS retirement / oracle | Already enforced by `oracle:check`; reuse, never restore `apps/server` |
| Core source / consumers | Existing runtime, Python control, Worker and packaged consumers; map only in C1 |
| Root/local entry and skills | Root policy exists; no local AGENTS or repo skills; update/add in C1 |
| Maps/contribution/design | Existing documents reused; stale TS defaults and source paths need correction |
| Research gate | Existing seven-field form + bounded prose exemption; extend reuse and negative cases |
| Full CI/duplicate release test | Current duties retained; selector/deduplication deferred to C3 |

## Current checkpoint — C1 locally accepted

C1 rules, maps, contribution/research policy and four on-demand skills are implemented. The six local
rule scopes are Web, Desktop, Python control, Python runtime, Node protocol, and frozen Server oracle.
Existing public documents and maintained Chinese translations are synchronized; no second design
platform, language selection, runtime loop, approval/budget/recovery authority or CI selector is added.
`catalog.py` changes only its research-reference docstring. Product behavior and startup/package scripts
remain unchanged. `apps/server` still contains its retirement README, not an active service.

The research gate keeps the full evidence form and narrow prose exemption. Its new existing-decision
shortcut is deliberately limited to established presentation/core helpers and tests. Dependency,
protocol/authority/persistence owners, new source, imports, instructions/prompts and unknown paths
cannot use that shortcut. Other ordinary fixes cite original research/pins in the full form without a
new survey. Semantic review is still required; filename checks are not proof of an unchanged boundary.

### Actual checks (2026-09-27)

All commands below ran in this C1 checkout. Node was 26.0.0 (within engines); package installation used
`npx --yes npm@10.9.9 ci --no-audit --no-fund` with the unchanged lockfile. Shell `npm run` used the
host CLI 11.12.1. Python bootstrap selected Python 3.12.13, without global package installs.

| Check | Actual result and limit |
| --- | --- |
| Baseline docs / research | 523 Markdown files; 17 research tests passed before edits |
| `npm run docs:check` | 4 entry/metadata/routing/symlink tests passed; 535 Markdown files with valid local links; pytest cache now excluded |
| `npm run research:check` | 22 tests passed, including real Git/CLI positive reuse and mixed dependency/authorization rejection; local non-PR invocation explicitly skips live PR-body validation |
| skill-creator `quick_validate.py` | All 4 actual SKILL.md files passed using the locked control Python environment's existing PyYAML |
| `apps/agent-runtime-python/scripts/bootstrap.sh` | Exact base environment: 23 pinned distributions |
| `apps/agent-runtime-python/scripts/check.sh -k catalog -rs` | 51 passed, 368 deselected; 1 optional module skipped because `temporalio` is absent. No Temporal/replay claim |
| `apps/server-python/scripts/bootstrap.sh` | Exact base environment: 52 pinned distributions |
| `npm run oracle:build` then `node apps/server-python/scripts/compare-runtime-wire.mjs` | Real installed TS/Python validation agreed on all 48 synthetic cases; no DB/model |
| `npm exec --workspace @openbot/web -- vitest run src/components/ChannelMembersMenu.test.tsx src/work-api.test.ts` | 2 files, 9 tests passed |
| `npm run check` | Exit 0, run after implementation and again after final checker correction. Final root Node suites: 196 passed / 2 platform-only skips; browser Python: 35 passed. Typecheck/test/build Turbo task groups: 31/31, 31/31, 19/19 successful; all those final task results cached |
| First complete check cache scope | Typecheck group 31 successful / 10 cached; test group 31 / 18 cached; build 19 / 14 cached. Repository prerequisites executed both times. Do not count final cache-replayed test logs as new test executions |
| `git diff --check`; startup/package comparison to base | Passed; `scripts/dev-python.mjs`, startup smoke, deployment files and Desktop package scripts unchanged |

Full-check skips remain explicit: Windows PowerShell and Linux installation native checks are not
executed on this Mac; retained Node/Desktop suites also report their existing platform-specific skips.
The final pass reused the first full check's unchanged consumer evidence. Existing Vite/chunk and
unrelated formatting warnings are not new passing qualification. No product services or user DB were
started. Raw local logs: `/private/tmp/openbot-c1-check.log`,
`/private/tmp/openbot-c1-check-final.log`, `/private/tmp/openbot-c1-core-check.log`, bootstrap/install
logs with the same prefix, and `/private/tmp/openbot-c1-discovery.json`. Logs are not committed.

### Native discovery and new-context reading

- Native Codex CLI `0.158.0-alpha.2.1`: `app-server` `skills/list` with `forceReload: true` for repo root,
  `apps/web`, `apps/agent-runtime-python` and `packages/protocol` returned all four `openbot-*` skills,
  enabled, with correct plain-file paths and no repository errors.
- Four fresh ephemeral read-only `thread/start` calls returned `instructionSources`: root AGENTS
  alone at root, root + correct local AGENTS for each of the three module directories. No `turn/start`
  was sent (zero model calls). This proves actual native discovery/loading, not file existence.
- The installed Homebrew CLI launcher was broken (missing vendor executable). The bundled native
  CLI was used instead; no tool was installed or user configuration changed. Sandbox-only native
  startup could not initialize local Codex state; the approved local protocol run succeeded.
- A separate Codex subagent with no inherited conversation located all three tasks using only the
  repository root and normal task goals. It actually read root/local rules and linked skill bodies.
  This independently verifies explicit on-demand reading, not a fresh paid API experiment.

| Reading task | Located behavior and validation |
| --- | --- |
| Menu close/focus | `ChannelMembersMenu.tsx`, native details/summary, App toolbar join/remove/profile consumers; component test and real-page focus/viewport requirements |
| Core catalog repair | `catalog.py`, `contracts.py`, `sdk_ports.py`; `work_runtime_ports.py` / `work_product_runtime.py` and Desktop payload consumer; locked synthetic catalog check; current RESEARCH section 9 |
| Runtime wire error boundary | Python parent `runtime_wire.py` + child `wire.py`, process error mapping, frozen TS schema and 48-case comparator; distinguishes internal process from Temporal composition |

The exercise exposed and fixed the map's incorrect current UI parent (App toolbar versus the embedded
ChannelWorkspace menu), old TS contribution paths/default claims, and obsolete catalog/protocol
references. The reader verified the main corrections; root checked the final two exact lines after
its review. Historical research and frozen oracle contents remain intact. Skills remain outside
product resources; existing Desktop staging selects explicit Python/Node/resource directories.

### Unverified and handoff state

- C1 hosted CI is not run: no push/PR/merge was authorized. Base CI success is not C1 CI success.
- No fresh rendered UI change, live model, product startup, native package or Temporal replay was
  required/executed for C1. C3's complete contribution journeys and C2's wheel/real consumer checks
  remain future acceptance; the reading exercise does not replace them.
- No local C1 technical blocker remains. The Worker venv/engine and native target qualification must
  be prepared if the next authorized slice touches those paths. Do not infer them from base checks.
- All test/bootstrap processes and the read-only reviewer finished. The current task is the sole
  writer. C1 is preserved by the local commit containing this handoff on `codex/repository-c1`;
  resolve its exact revision with `git rev-parse HEAD`. The tracked working tree is clean at handoff.
  C2/C3 remain unstarted; no remote branch or user asset was modified.

## Next slice and boundaries

C2, only after C1 acceptance: inventory runtime imports, process and Temporal consumers, build/locks
and packaged resource paths; extract the existing harness with a real wheel and actual consumer.
Keep public API promises narrow; prove one extension example and one real contract consumer.
C3 then handles CI scope/duplication and the full three contribution journeys. No C2/C3 completion
is implied by documentation, discovery or the C1 locate-only exercises.

## 中文摘要

本轮仅基线与 C1。旧目录及用户未提交资产保留；在实时核实的主线建立独立 C1 分支。
C1 本地验收已通过：修正根/六处局部规则、地图/贡献/设计入口，加入四个按需开发 skills；研究门
支持复用有效决定，依赖/协议/权限/持久化变化仍保留证据。真实 Codex 临时会话验证发现/加载，
无继承背景的只读上下文完成三类定位，并据此修正 App 菜单父级等误导。
实跑：入口 4 项、研究 22 项、535 份文档；catalog 51 通过/1 个 Temporal 模块跳过；跨语言 48 例；
UI/API 9 项；完整 npm check 通过，最终 Turbo 结果均复用缓存，根级检查实际重跑。
无本地 C1 技术阻断；候选未推送，故未验证 C1 云端 CI，未合并/发布。原目录及用户资产保留。
C2 wheel/消费者和 C3 CI/完整贡献流程尚未开始，不能把本轮阅读验收当作这些事项完成。

## Continued delivery — C2 in progress

C1 is preserved at `a770d870e81cb2295a1c4ed76da7796997c67716`. The same checkout/branch
continues; one writer owns the integration. C1 paths above record that historical revision.

The move retains `openbot_agent_runtime` and every loop, guard, wire and Temporal name. All 12
source modules, tests, locks, research and contributor rules move together to `packages/harness`;
there is no second implementation or empty application shell. Active scripts/consumer source paths
and local links follow the move. Frozen oracle and historical migration handoff are not new status.

| Consumer | Current boundary / C2 work |
| --- | --- |
| Ordinary process | `runtime_executor.py` and `run-worker.py`; keep one invocation, pipes, teardown; install wheel |
| Product / Temporal | `work_runtime_ports.py`, `work_product_runtime.py`, `work_worker.py`; preserve control factories and replay IDs; Worker environment installs wheel |
| Local development | `serve.py`, `dispatch-work.py`, `.worker-venv`; remove source-path dependency after install |
| Container | `deploy/server/Dockerfile`; build wheel once, install to product venv, no source copy |
| Desktop | `python-runtime.mjs`; install same wheel to pinned Python, keep Node parser closure |
| Checks / experiments | core scripts, control acceptance, CI Worker closure, experiments; paths and environment validation follow package |

Docker 29.5.2 is available locally through the approved local socket. C2 checks are pending; a
path-only move is not wheel, consumer or Temporal qualification. C3 remains unstarted.

中文：用户要求继续，现进入 C2，随后 C3；上文 C1 证据仍按原版本复用。当前唯一写入者继续维护
本交接；搬迁与打包/行为改动分开，尚不宣称 wheel、产品消费者或恢复验收完成。

Path-move check: original core suite 419 passed / 1 optional Temporal module skipped (60.15s);
no runtime implementation bytes changed. Docs: 4 routing tests / 535 Markdown files passed.
Research reference grammar now also accepts package-owned RESEARCH after its directory move.


### C2 current local evidence (in progress, 2026-09-27)

Path-only commit: `17fb2f4`; package/integration changes remain owned by this task and uncommitted.
Hatchling wheel, explicit public imports, optional Temporal import, separate build/quality locks,
Ruff/mypy and import/size gates are implemented. Four legacy module caps have concrete reasons;
no automatic baseline refresh. Core tests now consume an installed wheel, not pytest pythonpath.
Product external closure is 58 pins derived from existing Worker metadata, plus the local package;
Worker test closure is 63 external + local. Runtime and dev core closures are 18/23 external + local.

| C2 check | Actual evidence |
| --- | --- |
| Outside-repo wheel | clean venv, `-I`, site-packages path; exact 19 distributions; no DB/Temporal/pytest/build tools; synthetic tool returned canonical/model/UI results |
| Full core regression | 436 passed, 1 optional Temporal module skipped, 63.96s; explicit separate Worker validation below |
| Extension | 6 passed: canonical projection, declined authority, error, unknown without retry, cancellation, mid-read revocation; resource cleanup asserted |
| Type/quality | Ruff/format and mypy passed, 18 core/example/real-adapter and new contract/lock script files; explicit repo config avoids user-global Ruff rules |
| Cross-language | generated real Work GET response, Web uses generated type + Zod; 11 Python HTTP/DTO→Web cases passed; Web typecheck/freshness passed |
| Actual mTLS Temporal | concurrent Runs / isolated cancellation accounting and artifacts / real offline replay passed; public HTTP + PostgreSQL + scripted ports; no live model |
| Container | `runtime-product` image built on arm64; smoke passed login, built Web, docx/pdf/OCR initialization, restart/persistent keys/files, 45 migrations, preflight refusal, SIGTERM and resource cleanup |
| Desktop | real macOS arm64 payload staged; 59-pin product check and pip check pass; actual start/login/restart, parent EOF and invalid-config/symlink cleanup passed; synthetic encryption, native Keychain not claimed |
| Same implementation | SHA-256 comparison of all 12 current source modules matches core venv, Worker venv, staged Desktop and container installed packages |

Corrected actual integration failures: an old test injected the former eager Temporal module;
lazy-import injection now exercises the same refusal. Desktop build venv bundled pip lacks
`--resume-retries`, so only that build-tool invocation uses supported arguments (no pip upgrade).
Desktop launcher still selected `--worker` after the production split; it now uses `--product`.
Experimental path-injection removal left two malformed imports; all modified Python now parses,
and the corrected real mTLS journey passed. The Work acceptance file was moved out of product src
so the lean container build need not install Vitest. Full-root scanner exclusions now account for
the two explicit generated tool venvs, preserving frozen oracle/source symlink refusal.

C2 locally accepted at `b6e623a` plus the following quality-coverage follow-up. Full
`npm run check` exited 0; final Turbo build 19/19 successful, 18 cached. PostgreSQL base:
836 passed / 2 skipped in 105.89s. Worker: 1526 passed / 1 skipped in 540.08s. Existing
300s/600s timeouts were not increased. Cross-language comparisons also passed: identity 129,
tasks/usage 60, runtime 48, commands 34 and execution values 40. The base/Worker skips are
reported as unexecuted; independent actual Temporal replay above remains the durable evidence.
All 13 public-import boundary tests passed after exporting the two existing catalog ceilings
needed by the real OpenAI adapter. Quality now covers 18 typed files, including new contract
and product-lock scripts. Outside-checkout wheel install passed again (19 distributions).
Final macOS arm64 preview and arm64 container rebuilt from the current source, passed their
actual start/restart/refusal/cleanup probes, and all 12 installed source-module hashes matched
core, Worker, preview and container. The old generated native-runtime is earlier evidence only.
A fixed-revision read-only second reviewer found no confirmed functional regression in
`17fb2f4..b6e623a`; it did not execute tests. Hosted platform jobs, packaged preview, native
Keychain and Windows/Linux native clients are not established by these local checks.
Logs: `/private/tmp/openbot-c2-{control-final,check,desktop-final-smoke,container-final-smoke,contracts-final,wheel-final}.log`.
No push, remote CI, release, paid model or production mutation occurred.

## Current delivery — C3

One implementation owner continues in the same checkout. C2 artifact/check writers have
finished. The fixed-diff reviewer is finished. C3 will verify scope fixtures before allowing
conditional jobs; preserve full `npm run check`, production security and final success-only
aggregation; then run the three real fresh-context contributor journeys. Hosted CI at the
final candidate remains pending explicit push authorization, not a waived completion gate.

中文当前状态：C1、C2 已在本地验收，C3 进行中。C2 实际安装包、真实消费者、类型/依赖边界、
扩展范例和 Work 契约消费链均已验证；控制基础 836、Worker 1526 项通过，原有跳过如实保留。
容器和 macOS 预览载荷最终版本实跑通过并核对源码哈希。尚未推送/运行候选云端 CI，未签名、
安装到用户应用、调用付费模型或修改生产数据。接下来为 CI 选择/汇总与新会话完整贡献验收。
